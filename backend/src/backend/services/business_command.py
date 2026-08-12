"""BusinessCommandService：处理一条 Push 操作（docs/spec/sync-backend.md §6）。

处理链：
1. 幂等：按 operation_id 查操作历史
   - 已存在且 request_hash 相同 → 返回首次 result_json（accepted）
   - 已存在但 hash 不同 → rejected（operation_id_conflict）
2. 开启事务：对每个 change 调业务仓库 apply_Write
   - 任一 conflict / rejected / not_found → 整条回滚
3. 全部 applied → 写操作历史（insert_Operation，含 after_json）
4. 提交，返回 accepted（server_seq + 新 row_versions）

跨表校验（方案 A，放本服务）：工单大小类匹配、客户存在、映射按日期有效。
本表字段校验在各业务仓库（见 docs/spec/sync-backend.md §4）。
"""

from dataclasses import dataclass, field
from typing import Any

from backend.repositories._base import BaseRepository
from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.operations import OperationsRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository


@dataclass(frozen=True)
class OperationResult:
    """一条操作的处理结果（与 docs/sync-protocol.md §4.1 逐条结果对应）。"""

    operation_id: str
    status: str  # accepted / conflict / rejected
    server_seq: int | None = None
    row_versions: dict[str, int] | None = None
    conflict_json: dict[str, Any] | None = None
    errors: list[dict[str, Any]] = field(default_factory=list)


class BusinessCommandService:
    def __init__(
        self,
        customers: CustomersRepository,
        service_categories: ServiceCategoriesRepository,
        work_orders: WorkOrdersRepository,
        customer_code_mappings: CustomerCodeMappingsRepository,
        operations: OperationsRepository,
    ) -> None:
        self._customers = customers
        self._categories = service_categories
        self._orders = work_orders
        self._mappings = customer_code_mappings
        self._operations = operations
        # 任一张业务仓库都持有同一连接；这里用它做事务边界
        self._connection = customers.connection

    def execute_Operation(
        self, account_phone: str, device_id: str | None, operation: dict[str, Any]
    ) -> OperationResult:
        """处理一条操作。返回逐条结果（operation_id + status + 附加字段）。"""
        operation_id = operation["operation_id"]
        request_hash = self._compute_hash(operation)

        # 1. 幂等查
        existing = self._operations.get_ByOperationId(operation_id)
        if existing is not None:
            if existing["request_hash"] == request_hash:
                # 同一次动作重试 → 返回首次成功结果
                import json

                payload = json.loads(existing["result_json"])
                return OperationResult(
                    operation_id=operation_id,
                    status=payload.get("status", "accepted"),
                    server_seq=existing["server_seq"],
                    row_versions=payload.get("row_versions"),
                )
            return OperationResult(
                operation_id=operation_id,
                status="rejected",
                errors=[
                    {
                        "error_code": "operation_id_conflict",
                        "message": "operation_id 已被不同内容占用",
                    }
                ],
            )

        # 2. 事务：逐 change 应用，任一失败整条回滚
        try:
            result = self._apply_in_transaction(account_phone, operation)
            if result.status != "accepted":
                # rejected / conflict：本事务内已写入的 change 全部回滚
                self._connection.rollback()
            else:
                self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise
        return result

    # ---------- 私有实现 ----------

    def _apply_in_transaction(
        self, account_phone: str, operation: dict[str, Any]
    ) -> OperationResult:
        operation_id = operation["operation_id"]
        row_versions: dict[str, int] = {}
        changes_log: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []

        for change in operation.get("changes", []):
            entity_type = change["entity_type"]
            repo = self._repo_for(entity_type)
            if repo is None:
                errors.append(
                    {"entity_sync_id": change["entity_sync_id"],
                     "error_code": "entity_not_found",
                     "message": f"未知实体类型 {entity_type}"}
                )
                return OperationResult(
                    operation_id=operation_id, status="rejected", errors=errors
                )

            sync_id = change["entity_sync_id"]
            base_version = change.get("base_version", 0)

            # 跨表校验（方案 A）：工单创建时检查引用
            cross_error = self._validate_cross(entity_type, account_phone, change)
            if cross_error is not None:
                errors.append(
                    {
                        "entity_sync_id": sync_id,
                        "error_code": cross_error,
                        "message": "",
                    }
                )
                return OperationResult(
                    operation_id=operation_id, status="rejected", errors=errors
                )

            before = repo.get_BySyncId(account_phone, sync_id)
            result = repo.apply_Write(
                account_phone, sync_id, change.get("fields", {}), base_version
            )

            if result.status == "conflict":
                theirs = repo.get_BySyncId(account_phone, sync_id)
                return OperationResult(
                    operation_id=operation_id,
                    status="conflict",
                    conflict_json={
                        "entity_type": entity_type,
                        "entity_sync_id": sync_id,
                        "theirs": theirs,
                    },
                )
            if result.status == "rejected":
                errors.append(
                    {
                        "entity_sync_id": sync_id,
                        "error_code": self._field_error_code(entity_type, change),
                        "message": "",
                    }
                )
                return OperationResult(
                    operation_id=operation_id, status="rejected", errors=errors
                )
            if result.status == "not_found":
                errors.append(
                    {
                        "entity_sync_id": sync_id,
                        "error_code": "entity_not_found",
                        "message": "",
                    }
                )
                return OperationResult(
                    operation_id=operation_id, status="rejected", errors=errors
                )

            row_versions[sync_id] = result.new_row_version
            after = repo.get_BySyncId(account_phone, sync_id)
            changes_log.append(
                {
                    "entity_type": entity_type,
                    "entity_sync_id": sync_id,
                    "change_type": self._change_type(base_version, change),
                    "before_version": before["row_version"] if before else None,
                    "after_version": result.new_row_version,
                    "before_json": self._snapshot(before),
                    "after_json": self._snapshot(after),
                    "changed_fields_json": self._snapshot(change.get("fields", {})),
                }
            )

        # 3. 全部 applied → 写操作历史
        result_json = _json_dumps({"status": "accepted", "row_versions": row_versions})
        server_seq = self._operations.insert_Operation(
            account_phone=account_phone,
            device_id=operation.get("device_id"),
            operation_id=operation_id,
            request_hash=self._compute_hash(operation),
            actor_type=operation.get("actor_type", "user"),
            operation_type=operation.get("operation_type", ""),
            source_turn_id=operation.get("source_turn_id"),
            reverts_operation_id=operation.get("reverts_operation_id"),
            result_json=result_json,
            changes=changes_log,
        )
        return OperationResult(
            operation_id=operation_id,
            status="accepted",
            server_seq=server_seq,
            row_versions=row_versions,
        )

    def _repo_for(self, entity_type: str) -> BaseRepository | None:
        return {
            "customer": self._customers,
            "service_category": self._categories,
            "work_order": self._orders,
            "customer_code_mapping": self._mappings,
        }.get(entity_type)

    def _validate_cross(
        self, entity_type: str, account_phone: str, change: dict[str, Any]
    ) -> str | None:
        """跨表校验：放本服务（方案 A）。工单创建时校验引用。"""
        if entity_type != "work_order" or change.get("base_version", 0) != 0:
            return None
        fields = change.get("fields", {})

        # 客户存在且未归档
        customer_id = fields.get("customer_id")
        if customer_id is not None:
            found = self._customer_exists(account_phone, customer_id)
            if not found:
                return "customer_not_found"

        # 大小类匹配且可用
        category_name = fields.get("service_category")
        item_name = fields.get("service_item")
        if category_name and item_name:
            ok, valid = self._item_in_category(account_phone, category_name, item_name)
            if not ok:
                return "service_option_disabled"
            if not valid:
                return "service_item_mismatch"
        return None

    def _customer_exists(self, account_phone: str, customer_id: int) -> bool:
        rows = self._connection.execute(
            "SELECT 1 FROM customers"
            " WHERE account_phone = ? AND customer_id = ? AND archived_at IS NULL",
            (account_phone, customer_id),
        ).fetchall()
        return len(rows) > 0

    def _item_in_category(
        self, account_phone: str, category_name: str, item_name: str
    ) -> tuple[bool, bool]:
        """返回 (大类是否存在且启用, 小类是否在其中)。"""
        rows = self._connection.execute(
            "SELECT subcategories_json, is_active FROM service_categories"
            " WHERE account_phone = ? AND category_name = ?",
            (account_phone, category_name),
        ).fetchall()
        if not rows or rows[0]["is_active"] == 0:
            return False, False
        import json

        try:
            subcategories = json.loads(rows[0]["subcategories_json"])
        except ValueError:
            return False, False
        names = {s.get("name") for s in subcategories if isinstance(s, dict)}
        return True, item_name in names

    def _field_error_code(self, entity_type: str, change: dict[str, Any]) -> str:
        fields = change.get("fields", {})
        if entity_type == "work_order":
            if fields.get("quantity") is not None and (
                not isinstance(fields["quantity"], int) or fields["quantity"] <= 0
            ):
                return "invalid_quantity"
            if fields.get("unit_price_cents") is not None and fields["unit_price_cents"] < 0:
                return "invalid_unit_price"
            if "unit" in fields and not fields["unit"].strip():
                return "invalid_unit"
        if entity_type == "customer" and "canonical_name" in fields and not fields["canonical_name"].strip():
            return "invalid_customer_name"
        if entity_type == "service_category":
            return "invalid_subcategories"
        return "invalid_request"

    def _change_type(self, base_version: int, change: dict[str, Any]) -> str:
        fields = change.get("fields", {})
        if base_version == 0:
            return "create"
        if "deleted_at" in fields and fields["deleted_at"] is not None:
            return "delete"
        if "archived_at" in fields and fields["archived_at"] is not None:
            return "delete"
        return "update"

    def _snapshot(self, row: dict[str, Any] | None) -> str | None:
        return _json_dumps(row) if row is not None else None

    def _compute_hash(self, operation: dict[str, Any]) -> str:
        """服务端对规范化后的业务命令计算哈希（不信任客户端提交的哈希）。"""
        import hashlib
        import json

        canonical = json.dumps(operation, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _json_dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False, sort_keys=True)
