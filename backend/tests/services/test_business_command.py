"""缝 13：BusinessCommandService 测试（docs/spec/sync-backend.md §6）。

被测缝：execute_Operation 的公开接口——幂等、rejected（本表 + 跨表校验）、
conflict、原子性、成功路径。跨表校验需要真实的业务仓库做前置数据。

每条测试验证：docs/spec/sync-backend.md §6 处理链的字面量语义。
"""

import pytest

from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.operations import OperationsRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository
from backend.services.business_command import BusinessCommandService


@pytest.fixture
def service(connection):
    return BusinessCommandService(
        customers=CustomersRepository(connection),
        service_categories=ServiceCategoriesRepository(connection),
        work_orders=WorkOrdersRepository(connection),
        customer_code_mappings=CustomerCodeMappingsRepository(connection),
        operations=OperationsRepository(connection),
    )


def _customer_op(customer_sync_id="sync-000000000001", **overrides):
    op = {
        "operation_id": "op-000000000001",
        "operation_type": "create_customer",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer",
                "entity_sync_id": customer_sync_id,
                "base_version": 0,
                "fields": {"canonical_name": "某某厂"},
            }
        ],
    }
    op.update(overrides)
    return op


def test_accepts_create_customer(service, connection):
    # 成功路径：create customer → accepted，业务表写入、历史记录、返回新版本
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())

    assert result.status == "accepted"
    assert result.server_seq >= 1
    assert result.row_versions == {"sync-000000000001": 1}
    row = connection.execute(
        "SELECT canonical_name, row_version FROM customers"
        " WHERE sync_id = 'sync-000000000001'"
    ).fetchone()
    assert row["canonical_name"] == "某某厂"
    assert row["row_version"] == 1


def test_idempotent_retry_returns_first_result(service):
    # 幂等：同 operation_id + 同 hash 重试 → 直接返回首次结果，不再写业务表
    first = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())
    second = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())

    assert second.status == "accepted"
    assert second.server_seq == first.server_seq
    assert second.row_versions == first.row_versions


def test_idempotent_retry_does_not_bump_version(service, connection):
    # 幂等重试不改业务表：row_version 不因重试递增
    service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())
    service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())

    row = connection.execute(
        "SELECT row_version FROM customers WHERE sync_id = 'sync-000000000001'"
    ).fetchone()
    assert row["row_version"] == 1


def test_rejects_conflicting_operation_id(service, connection):
    # operation_id 已存在但内容不同（request_hash 不同）→ rejected（operation_id_conflict）
    service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", _customer_op())

    # 同一 operation_id，但 changes 不同 → hash 不同
    different = _customer_op(
        changes=[
            {
                "entity_type": "customer",
                "entity_sync_id": "sync-000000000002",
                "base_version": 0,
                "fields": {"canonical_name": "另一家"},
            }
        ]
    )
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", different)
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "operation_id_conflict"


def test_rejects_bad_field_within_operation(service):
    # rejected（本表校验）：工单数量非法 → 整条 rejected，不写业务表也不留历史
    op = {
        "operation_id": "op-000000000002",
        "operation_type": "create_work_order",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": "sync-000000000002",
                "base_version": 0,
                "fields": {
                    "work_order_date": "2026-08-12",
                    "customer_id": 1,
                    "customer_code": "001",
                    "customer_name": "甲",
                    "service_category": "洗水",
                    "service_item": "单洗",
                    "quantity": 0,  # 非法
                    "unit": "件",
                    "unit_price_cents": None,
                    "is_completed": 0,
                },
            }
        ],
    }
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", op)
    assert result.status == "rejected"


def test_operation_is_atomic_rolls_back_all(service, connection):
    # 原子性：一条操作内 2 个 change，第 2 个非法 → 整条回滚，第 1 个也不落库、不留历史
    op = {
        "operation_id": "op-000000000003",
        "operation_type": "create_customer_batch",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer",
                "entity_sync_id": "sync-000000000001",
                "base_version": 0,
                "fields": {"canonical_name": "合法客户"},
            },
            {
                "entity_type": "customer",
                "entity_sync_id": "sync-000000000002",
                "base_version": 0,
                "fields": {"canonical_name": ""},  # 非法：名称为空
            },
        ],
    }
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", op)
    assert result.status == "rejected"

    # 第一个合法 change 也不落库
    assert connection.execute(
        "SELECT 1 FROM customers WHERE sync_id = 'sync-000000000001'"
    ).fetchone() is None
    # 不留操作历史
    assert connection.execute(
        "SELECT 1 FROM database_operations WHERE operation_id = 'op-000000000003'"
    ).fetchone() is None


def test_work_order_cross_rule_mismatch(service, connection):
    # 跨表校验：工单的小类不属于所选大类 → rejected（service_item_mismatch）
    # 前置：客户 + 服务大类都要存在，才能单独验证"小类不匹配"这一条规则
    service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        {
            "operation_id": "op-000000000010",
            "operation_type": "create_customer",
            "actor_type": "user",
            "source_turn_id": None,
            "changes": [
                {
                    "entity_type": "customer",
                    "entity_sync_id": "sync-000000000900",
                    "base_version": 0,
                    "fields": {"canonical_name": "某某厂"},
                }
            ],
        },
    )
    ServiceCategoriesRepository(connection).apply_Write(
        "13800000000",
        "sync-000000000100",
        {"category_name": "洗水", "subcategories_json": '[]', "is_active": 1},
        0,
    )
    op = {
        "operation_id": "op-000000000004",
        "operation_type": "create_work_order",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": "sync-000000000002",
                "base_version": 0,
                "fields": {
                    "work_order_date": "2026-08-12",
                    "customer_id": 1,
                    "customer_code": "001",
                    "customer_name": "甲",
                    "service_category": "洗水",
                    "service_item": "不存在的项",
                    "quantity": 1,
                    "unit": "件",
                    "unit_price_cents": None,
                    "is_completed": 0,
                },
            }
        ],
    }
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", op)
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "service_item_mismatch"


def test_work_order_cross_rule_customer_not_found(service, connection):
    # 跨表校验：工单引用不存在的客户 → rejected（customer_not_found）
    op = {
        "operation_id": "op-000000000005",
        "operation_type": "create_work_order",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": "sync-000000000003",
                "base_version": 0,
                "fields": {
                    "work_order_date": "2026-08-12",
                    "customer_id": 999,
                    "customer_code": "001",
                    "customer_name": "甲",
                    "service_category": "洗水",
                    "service_item": "单洗",
                    "quantity": 1,
                    "unit": "件",
                    "unit_price_cents": None,
                    "is_completed": 0,
                },
            }
        ],
    }
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", op)
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "customer_not_found"


def test_accepts_create_customer_code_mapping(service, connection):
    # 第四张业务表：编号映射也能 Push accepted（曾因 _repo_for 缺映射而 rejected）
    op = {
        "operation_id": "op-000000000006",
        "operation_type": "create_customer_code_mapping",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer_code_mapping",
                "entity_sync_id": "sync-000000000004",
                "base_version": 0,
                "fields": {
                    "customer_id": 1,
                    "customer_code": "001",
                    "customer_name": "甲",
                    "valid_from": "2026-08-01",
                    "valid_to": None,
                },
            }
        ],
    }
    result = service.execute_Operation("13800000000", "dev-a1b2c3d4e5f6", op)
    assert result.status == "accepted"
    assert result.row_versions == {"sync-000000000004": 1}
