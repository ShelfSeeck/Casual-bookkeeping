"""BusinessCommandService：处理一条 Push 操作（docs/spec/sync-backend.md §6）。

处理链：
1. 幂等：按 operation_id 查操作历史
   - 已存在且 request_hash 相同 → 返回首次 result_json（accepted）
   - 已存在但 hash 不同 → rejected（operation_id_conflict）
2. 开启事务：对每个 change 调业务仓库 apply_Write
   - 任一 conflict / rejected / not_found → 整条回滚
3. 全部 applied → 写操作历史（insert_Operation，含 after_json）
4. 提交，返回 accepted（server_seq + 新 row_versions）

跨表校验（方案 A，放本服务）：工单大小类匹配、客户存在、映射按日期有效；
create/update 均按「现记录 ∪ patch」合并后的目标状态校验（docs/spec/business-p0p1.md §5.3/§5.4）。
本表字段校验在各业务仓库（见 docs/spec/sync-backend.md §4）。
"""

from dataclasses import dataclass, field
from datetime import datetime, timezone
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
            if existing["account_phone"] != account_phone:
                return OperationResult(
                    operation_id=operation_id,
                    status="rejected",
                    errors=[
                        {
                            "error_code": "operation_id_conflict",
                            "message": "operation_id 已被占用",
                        }
                    ],
                )
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

        # 2. 撤回展开（幂等检查之后、changes 循环之前）：把撤回意图展开成
        # 反向 changes，再继续走普通写入管线（docs/data-model.md §6.5）。
        effective_operation = operation
        if operation.get("reverts_operation_id"):
            expanded_changes, revert_error = self._expand_revert(
                account_phone, operation
            )
            if revert_error is not None:
                return revert_error
            effective_operation = {**operation, "changes": expanded_changes}

        # 3. 事务：逐 change 应用，任一失败整条回滚
        try:
            result = self._apply_in_transaction(
                account_phone, device_id, effective_operation, request_hash
            )
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

    def _expand_revert(
        self, account_phone: str, operation: dict[str, Any]
    ) -> tuple[list[dict[str, Any]] | None, OperationResult | None]:
        """撤回展开：校验目标并生成反向 changes（docs/data-model.md §6.5）。

        - 目标不存在 / 不属于当前账户 → revert_target_not_found。
        - 目标本身是撤回操作、已被其他撤回指向、或含 MVP 不支持的实体 create
          → revert_target_invalid。
        - 展开后的 changes 按原操作的 change_id 升序，base_version 取目标
          after_version，fields 取目标 before_json（create 的工单等价软删）。
        返回 (changes, error_result)，成功时 error_result 为 None。
        """
        operation_id = operation["operation_id"]
        reverts_operation_id = operation["reverts_operation_id"]

        target = self._operations.get_ByOperationId(reverts_operation_id)
        if target is None or target["account_phone"] != account_phone:
            return None, self._revert_error(operation_id, "revert_target_not_found")
        if target["reverts_operation_id"] or self._operations.find_RevertOfOperation(
            account_phone, reverts_operation_id
        ):
            return None, self._revert_error(operation_id, "revert_target_invalid")

        expanded: list[dict[str, Any]] = []
        for row in self._operations.get_ChangesByOperationId(reverts_operation_id):
            if row["before_json"] is None:
                # 目标是一次 create：MVP 只支持工单 create 的撤回（等价软删）
                if row["entity_type"] != "work_order":
                    return None, self._revert_error(
                        operation_id, "revert_target_invalid"
                    )
                expanded.append(
                    {
                        "entity_type": row["entity_type"],
                        "entity_sync_id": row["entity_sync_id"],
                        "base_version": row["after_version"],
                        "fields": {
                            "deleted_at": datetime.now(timezone.utc).isoformat()
                        },
                    }
                )
            else:
                import json

                expanded.append(
                    {
                        "entity_type": row["entity_type"],
                        "entity_sync_id": row["entity_sync_id"],
                        "base_version": row["after_version"],
                        "fields": json.loads(row["before_json"]),
                    }
                )
        return expanded, None

    def _revert_error(self, operation_id: str, error_code: str) -> OperationResult:
        """撤回校验失败的逐条结果（errors 形状照抄 docs/sync-protocol.md §4.1）。"""
        return OperationResult(
            operation_id=operation_id,
            status="rejected",
            errors=[
                {
                    "entity_sync_id": "",
                    "error_code": error_code,
                    "message": "",
                }
            ],
        )

    def _apply_in_transaction(
        self,
        account_phone: str,
        device_id: str | None,
        operation: dict[str, Any],
        request_hash: str,
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
                        "error_code": result.error_code or "invalid_request",
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
                    "changed_fields_json": self._changed_fields(before, after),
                }
            )

        # 3. 全部 applied → 写操作历史
        result_json = _json_dumps({"status": "accepted", "row_versions": row_versions})
        server_seq = self._operations.insert_Operation(
            account_phone=account_phone,
            device_id=device_id,
            operation_id=operation_id,
            request_hash=request_hash,
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
        """跨表校验：放本服务（方案 A）。

        - work_order：create 校验 change.fields；update 校验 {现记录, **fields}
          合并后的目标状态，且只对 patch 触及的规则做校验（§5.4）。
        - customer_code_mapping：create/update 校验 customer_id 存在性与
          同编号重叠区间（含端点，§5.3）。
        """
        base_version = change.get("base_version", 0)
        fields = change.get("fields", {})
        sync_id = change.get("entity_sync_id", "")

        if entity_type == "work_order":
            return self._validate_work_order_cross(
                account_phone, base_version, fields, sync_id
            )
        if entity_type == "customer_code_mapping":
            return self._validate_mapping_cross(
                account_phone, base_version, fields, sync_id
            )
        return None

    def _validate_work_order_cross(
        self,
        account_phone: str,
        base_version: int,
        fields: dict[str, Any],
        sync_id: str,
    ) -> str | None:
        if base_version == 0:
            merged = fields
        else:
            existing = self._orders.get_BySyncId(account_phone, sync_id)
            if existing is None:
                # 记录不存在交给 apply_Write 报 entity_not_found
                return None
            merged = {**existing, **fields}

        # service_item 类型守卫：非 None 且非 str → invalid_service_item。
        # 仓库层也校验，但 cross 先于 apply_Write 执行，须在此先兜底，
        # 避免把 123 这类值误判成 service_item_mismatch。
        if base_version == 0 or "service_item" in fields:
            item_name = merged.get("service_item")
            if item_name is not None and not isinstance(item_name, str):
                return "invalid_service_item"

        # 客户存在且未归档：create 同现状；update 仅当 patch 触及 customer_id
        if base_version == 0 or "customer_id" in fields:
            customer_id = merged.get("customer_id")
            if customer_id is not None and not self._customer_exists(account_phone, customer_id):
                return "customer_not_found"

        # 大小类匹配 + 大类启用 + 小类启用：create 必校验；update 仅当 patch 改变了
        # service_category 或 service_item 时校验（避免历史工单只改数量/单价时被停用的大类误拦）。
        # 合并后 service_item 为空（空小类）合法。
        should_check_service = False
        if base_version == 0:
            should_check_service = True
        elif "service_category" in fields or "service_item" in fields:
            cat_changed = "service_category" in fields and (existing is None or fields["service_category"] != existing.get("service_category"))
            item_changed = "service_item" in fields and (existing is None or fields["service_item"] != existing.get("service_item"))
            should_check_service = cat_changed or item_changed

        if should_check_service:
            category_name = merged.get("service_category")
            item_name = merged.get("service_item")
            if category_name and item_name:
                error = self._validate_service_option(
                    account_phone, category_name, item_name
                )
                if error is not None:
                    return error

        # 编号映射按业务日期有效：create 同现状；update 仅当 patch 触及
        # work_order_date 或 customer_code，且用合并后的日期与编号。
        if base_version == 0 or "work_order_date" in fields or "customer_code" in fields:
            customer_code = merged.get("customer_code")
            work_order_date = merged.get("work_order_date")
            if customer_code and work_order_date:
                if not self._mapping_valid(account_phone, customer_code, work_order_date):
                    return "customer_mapping_invalid"
        return None

    def _validate_mapping_cross(
        self,
        account_phone: str,
        base_version: int,
        fields: dict[str, Any],
        sync_id: str,
    ) -> str | None:
        if base_version == 0:
            merged = fields
        else:
            existing = self._mappings.get_BySyncId(account_phone, sync_id)
            if existing is None:
                # 记录不存在交给 apply_Write 报 entity_not_found
                return None
            merged = {**existing, **fields}

        # customer_id 存在且未归档：create 必查；update 仅当字段出现
        if base_version == 0 or "customer_id" in fields:
            customer_id = merged.get("customer_id")
            if customer_id is None or not self._customer_exists(account_phone, customer_id):
                return "customer_not_found"

        # 同账户、同 customer_code、不同 sync_id 的重叠区间（含端点）。
        # valid_to 为空表示开放区间；SQL 里显式处理 NULL，避免 <= NULL 恒假。
        customer_code = merged.get("customer_code")
        valid_from = merged.get("valid_from")
        if customer_code is not None and valid_from is not None:
            valid_to = merged.get("valid_to")
            rows = self._connection.execute(
                "SELECT 1 FROM customer_code_mappings"
                " WHERE account_phone = ? AND customer_code = ? AND sync_id <> ?"
                " AND (? IS NULL OR valid_from <= ?)"
                " AND (valid_to IS NULL OR valid_to >= ?)",
                (
                    account_phone,
                    customer_code,
                    sync_id,
                    valid_to,
                    valid_to,
                    valid_from,
                ),
            ).fetchall()
            if rows:
                return "mapping_period_overlap"
        return None

    def _customer_exists(self, account_phone: str, customer_id: int) -> bool:
        rows = self._connection.execute(
            "SELECT 1 FROM customers"
            " WHERE account_phone = ? AND customer_id = ? AND archived_at IS NULL",
            (account_phone, customer_id),
        ).fetchall()
        return len(rows) > 0

    def _mapping_valid(
        self, account_phone: str, customer_code: str, work_order_date: str
    ) -> bool:
        """该业务日期是否存在有效的编号映射（docs/data-model.md §4.4 规则 1）。"""
        rows = self._connection.execute(
            "SELECT 1 FROM customer_code_mappings"
            " WHERE account_phone = ? AND customer_code = ?"
            " AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)",
            (account_phone, customer_code, work_order_date, work_order_date),
        ).fetchall()
        return len(rows) > 0

    def _validate_service_option(
        self, account_phone: str, category_name: str, item_name: str
    ) -> str | None:
        """校验大小类匹配与启用状态，返回错误码或 None。

        大类不存在/停用 → service_option_disabled；小类不在大类内 →
        service_item_mismatch；小类存在但 is_active=false → service_option_disabled。
        """
        rows = self._connection.execute(
            "SELECT subcategories_json, is_active FROM service_categories"
            " WHERE account_phone = ? AND category_name = ?",
            (account_phone, category_name),
        ).fetchall()
        if not rows or rows[0]["is_active"] == 0:
            return "service_option_disabled"
        import json

        try:
            subcategories = json.loads(rows[0]["subcategories_json"])
        except ValueError:
            return "service_option_disabled"
        if not isinstance(subcategories, list):
            return "service_option_disabled"
        for subcategory in subcategories:
            if isinstance(subcategory, dict) and subcategory.get("name") == item_name:
                if subcategory.get("is_active") is True:
                    return None
                return "service_option_disabled"
        return "service_item_mismatch"

    def _change_type(self, base_version: int, change: dict[str, Any]) -> str:
        fields = change.get("fields", {})
        if base_version == 0:
            return "create"
        if "deleted_at" in fields:
            return "delete" if fields["deleted_at"] is not None else "restore"
        if "archived_at" in fields:
            return "delete" if fields["archived_at"] is not None else "restore"
        return "update"

    def _changed_fields(self, before: dict[str, Any] | None, after: dict[str, Any]) -> str:
        """字段差异展示（docs/data-model.md §5.3 changed_fields_json）：create 记全量快照，
        其余只记发生变化的业务字段（排除 row_version/时间戳等账本字段）的 before/after。"""
        if before is None:
            return _json_dumps(after)
        meta = {"row_version", "updated_at", "created_at", "account_phone", "sync_id"}
        diff = {
            key: {"before": before.get(key), "after": value}
            for key, value in after.items()
            if key not in meta and before.get(key) != value
        }
        return _json_dumps(diff)

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
