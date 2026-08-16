"""同步路由（docs/spec/sync-backend.md §7）：Push / Pull / bootstrap。

三个端点全部经 get_CurrentAccount 鉴权并注入身份，账户隔离以注入的
account_phone 为准，不信任请求体里的账户参数。
契约详见 docs/sync-protocol.md §4；错误码见 docs/error-codes.md。
"""

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.errors import AppError
from backend.deps import (
    CurrentAccount,
    get_BusinessCommandService,
    get_CustomerCodeMappingsRepository,
    get_CurrentAccount,
    get_CustomersRepository,
    get_OperationsRepository,
    get_ServiceCategoriesRepository,
    get_WorkOrdersRepository,
)
from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.operations import OperationsRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository
from backend.services.business_command import BusinessCommandService

router = APIRouter(prefix="/sync", tags=["sync"])

# 批量上限（docs/sync-protocol.md §5）：条数 + 请求体字节，超出由客户端拆批。
PUSH_MAX_OPERATIONS = 500
PUSH_MAX_BYTES = 1_000_000  # 1MB

# Pull 上限（docs/sync-protocol.md §4.2）：limit 条数上限 500。
# MVP 以条数限流，不做响应字节截断；精确字节控制登记为未定事项（AGENTS.md）。
PULL_DEFAULT_LIMIT = 200
PULL_MAX_LIMIT = 500


class ChangeIn(BaseModel):
    entity_type: str
    entity_sync_id: str
    base_version: int
    fields: dict[str, Any]


class OperationIn(BaseModel):
    operation_id: str
    operation_type: str
    actor_type: str
    source_turn_id: str | None = None
    reverts_operation_id: str | None = None
    changes: list[ChangeIn]


class PushRequest(BaseModel):
    operations: list[OperationIn]


# ---------- POST /sync/push ----------

@router.post("/push")
def push(
    body: PushRequest,
    current: CurrentAccount = Depends(get_CurrentAccount),
    service: BusinessCommandService = Depends(get_BusinessCommandService),
) -> dict:
    # 批量上限：超出 400 invalid_request，客户端拆批重发（docs/sync-protocol.md §5）
    if len(body.operations) > PUSH_MAX_OPERATIONS:
        raise AppError(
            "invalid_request",
            f"批量操作数超过上限 {PUSH_MAX_OPERATIONS}",
            400,
        )
    if len(body.model_dump_json()) > PUSH_MAX_BYTES:
        raise AppError(
            "invalid_request",
            "请求体超过大小上限",
            400,
        )
    # 批量保序：按请求数组顺序逐条执行，结果与请求一一对应（docs/sync-protocol.md §4.1）
    results = []
    for operation in body.operations:
        result = service.execute_Operation(
            current.account_phone, current.device_id, operation.model_dump()
        )
        item: dict[str, Any] = {
            "operation_id": result.operation_id,
            "status": result.status,
        }
        if result.status == "accepted":
            item["server_seq"] = result.server_seq
            item["row_versions"] = result.row_versions
        elif result.status == "conflict":
            item["conflict_json"] = result.conflict_json
        elif result.status == "rejected":
            item["errors"] = result.errors
        results.append(item)
    return {"results": results}


# ---------- GET /sync/pull ----------

@router.get("/pull")
def pull(
    after: int = 0,
    limit: int = 200,
    current: CurrentAccount = Depends(get_CurrentAccount),
    operations_repo: OperationsRepository = Depends(get_OperationsRepository),
) -> dict:
    if limit < 1 or limit > PULL_MAX_LIMIT:
        limit = PULL_DEFAULT_LIMIT
    ops, has_more = operations_repo.list_AfterSeq(current.account_phone, after, limit)
    operations = []
    for op in ops:
        changes = operations_repo.get_ChangesByOperationId(op["operation_id"])
        operations.append(
            {
                "server_seq": op["server_seq"],
                "operation_id": op["operation_id"],
                "operation_type": op["operation_type"],
                "reverts_operation_id": op["reverts_operation_id"],
                "device_id": op["device_id"],
                "created_at": op["created_at"],
                "changes": [
                    {
                        "entity_type": c["entity_type"],
                        "entity_sync_id": c["entity_sync_id"],
                        "change_type": c["change_type"],
                        "after_json": c["after_json"],
                        "after_version": c["after_version"],
                        "before_json": c["before_json"],
                        "changed_fields_json": c["changed_fields_json"],
                    }
                    for c in changes
                ],
            }
        )
    return {"operations": operations, "has_more": has_more}


# ---------- GET /sync/bootstrap ----------

@router.get("/bootstrap")
def bootstrap(
    current: CurrentAccount = Depends(get_CurrentAccount),
    operations_repo: OperationsRepository = Depends(get_OperationsRepository),
    customers_repo: CustomersRepository = Depends(get_CustomersRepository),
    categories_repo: ServiceCategoriesRepository = Depends(get_ServiceCategoriesRepository),
    orders_repo: WorkOrdersRepository = Depends(get_WorkOrdersRepository),
    mappings_repo: CustomerCodeMappingsRepository = Depends(get_CustomerCodeMappingsRepository),
) -> dict:
    # 四表当前在用记录 + snapshot_seq（docs/sync-protocol.md §4.3）
    # MVP 扁平返回、不分页（数据量小）；cursor 编码留待分页需求出现时再定（AGENTS.md 未定事项）
    snapshot_seq = operations_repo.get_MaxSeq(current.account_phone)
    return {
        "snapshot_seq": snapshot_seq,
        "has_more": False,
        "customers": customers_repo.list_Active(current.account_phone),
        "service_categories": categories_repo.list_Active(current.account_phone),
        "work_orders": orders_repo.list_Active(current.account_phone),
        "customer_code_mappings": mappings_repo.list_Active(current.account_phone),
    }
