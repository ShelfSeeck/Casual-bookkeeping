"""缝 15：业务校验缺口补测（docs/spec/business-p0p1.md §5.1–§5.4）。

被测缝：四张业务仓库的公开接口（apply_Write / get_BySyncId）与
BusinessCommandService.execute_Operation 的公开接口。
覆盖 Task 1 的五组规则：
1. work_orders.service_item 可空 + 非字符串拒绝（invalid_service_item）
2. service_categories.subcategories_json 逐项结构校验
3. customer_code_mapping 重叠校验（create/update，含端点语义）
4. work_order update 路径的合并后跨表校验
5. customer_code_mapping create 的 customer_id 存在性校验

每条测试注释说明验证什么、为什么；期望值来自 docs/spec/business-p0p1.md 与
docs/error-codes.md 的字面量，不复算实现逻辑。
"""

import json

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


# ---------- 共享 helper ----------


def _make_order_fields(**overrides):
    fields = {
        "work_order_date": "2026-08-12",
        "customer_id": 1,
        "customer_code": "001",
        "customer_name": "甲",
        "service_category": "洗水",
        "service_item": "单洗",
        "quantity": 12,
        "unit": "件",
        "unit_price_cents": None,
        "is_completed": 0,
        "deleted_at": None,
    }
    fields.update(overrides)
    return fields


def _work_order_op(op_id, sync_id, fields, base_version=0):
    return {
        "operation_id": op_id,
        "operation_type": "create_work_order" if base_version == 0 else "update_work_order",
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "work_order",
                "entity_sync_id": sync_id,
                "base_version": base_version,
                "fields": fields,
            }
        ],
    }


def _mapping_op(op_id, sync_id, *, base_version=0, fields=None, **defaults):
    if fields is None:
        fields = {
            "customer_id": defaults.pop("customer_id", 1),
            "customer_code": defaults.pop("customer_code", "001"),
            "customer_name": defaults.pop("customer_name", "甲"),
            "valid_from": defaults.pop("valid_from", "2026-01-01"),
            "valid_to": defaults.pop("valid_to", None),
        }
    return {
        "operation_id": op_id,
        "operation_type": (
            "create_customer_code_mapping" if base_version == 0 else "update_customer_code_mapping"
        ),
        "actor_type": "user",
        "source_turn_id": None,
        "changes": [
            {
                "entity_type": "customer_code_mapping",
                "entity_sync_id": sync_id,
                "base_version": base_version,
                "fields": fields,
            }
        ],
    }


def _create_customer(service, op_id, sync_id, name="某某厂"):
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        {
            "operation_id": op_id,
            "operation_type": "create_customer",
            "actor_type": "user",
            "source_turn_id": None,
            "changes": [
                {
                    "entity_type": "customer",
                    "entity_sync_id": sync_id,
                    "base_version": 0,
                    "fields": {"canonical_name": name},
                }
            ],
        },
    )
    assert result.status == "accepted"
    return result


def _customer_id(connection, sync_id):
    row = connection.execute(
        "SELECT customer_id FROM customers WHERE sync_id = ?", (sync_id,)
    ).fetchone()
    assert row is not None
    return row["customer_id"]


# ---------- 1. work_orders.service_item 可空 / 非字符串 ----------


def test_order_create_accepts_null_service_item(connection):
    # G1：service_item=None 合法（先建空大类、小类后补），仓库层放行并落库为 NULL。
    repo = WorkOrdersRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _make_order_fields(service_item=None),
        0,
    )
    assert result.status == "applied"
    record = repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["service_item"] is None


def test_order_update_accepts_null_service_item(connection):
    # G1：update 把小类清空同样合法（service_item=NULL），不因 NOT NULL 约束失败。
    repo = WorkOrdersRepository(connection)
    repo.apply_Write(
        "13800000000", "sync-000000000001", _make_order_fields(), 0
    )
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"service_item": None},
        1,
    )
    assert result.status == "applied"
    record = repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["service_item"] is None


def test_order_create_rejects_non_string_service_item(connection):
    # service_item 既不是字符串也不是 None → rejected，错误码 invalid_service_item
    # （docs/error-codes.md §4.2 新增行）。
    repo = WorkOrdersRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _make_order_fields(service_item=123),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_service_item"


def test_order_update_rejects_non_string_service_item(connection):
    # 同一规则在 update 路径也必须生效：不能把 service_item 改成数字。
    repo = WorkOrdersRepository(connection)
    repo.apply_Write(
        "13800000000", "sync-000000000001", _make_order_fields(), 0
    )
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"service_item": 123},
        1,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_service_item"


def test_work_order_create_via_service_rejects_non_string_service_item(service):
    # Push 路径（BusinessCommandService）同样返回 invalid_service_item：
    # cross 校验先于 apply_Write 执行，不能把数字小类误判成 service_item_mismatch。
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000009",
            "sync-000000000009",
            _make_order_fields(service_item=123),
            0,
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "invalid_service_item"


# ---------- 2. service_categories.subcategories_json 结构校验 ----------


def _category_fields(subcategories_json, category_name="洗水"):
    return {
        "category_name": category_name,
        "subcategories_json": subcategories_json,
        "is_active": 1,
    }


def test_service_categories_rejects_unparsable_subcategories_json(connection):
    # G3：解析失败 → invalid_subcategories（docs/error-codes.md §4.2）。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields("not-json"),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_subcategories"


def test_service_categories_rejects_non_array_subcategories_json(connection):
    # G3：合法 JSON 但不是数组（对象）→ invalid_subcategories。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields('{"name":"单洗"}'),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_subcategories"


def test_service_categories_rejects_item_missing_name(connection):
    # G3：小类缺 name → invalid_subcategories（不再因名字缺失而漏过结构校验）。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields('[{"default_unit":"件","is_active":true}]'),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_subcategories"


def test_service_categories_rejects_item_empty_default_unit(connection):
    # G3：小类 default_unit 为空字符串 → invalid_subcategories（默认单位必须非空）。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields('[{"name":"单洗","default_unit":"","is_active":true}]'),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_subcategories"


def test_service_categories_rejects_item_non_bool_is_active(connection):
    # G3：is_active 不是布尔 → invalid_subcategories（结构损坏的小类不能进库）。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields('[{"name":"单洗","default_unit":"件","is_active":"true"}]'),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_subcategories"


def test_service_categories_rejects_duplicate_subcategory_name(connection):
    # G3：结构合法但 name 同数组内重复 → subcategory_name_duplicate（现有语义不变）。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields(
            '[{"name":"单洗","default_unit":"件","is_active":true},'
            '{"name":"单洗","default_unit":"袋","is_active":false}]'
        ),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "subcategory_name_duplicate"


def test_service_categories_accepts_valid_subcategories_json(connection):
    # G3：合法结构（含停用小类）应通过，保证校验不会误伤正常配置。
    repo = ServiceCategoriesRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _category_fields(
            '[{"name":"单洗","default_unit":"件","is_active":true},'
            '{"name":"烘干","default_unit":"件","is_active":false}]'
        ),
        0,
    )
    assert result.status == "applied"


# ---------- 3. customer_code_mapping 重叠校验 ----------


def test_mapping_create_rejects_overlap(service, connection):
    # G2：同账户同 customer_code 不同 sync_id 的映射区间重叠（含端点）→ rejected。
    _create_customer(service, "op-000000000101", "sync-000000000101")
    first = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000102",
            "sync-000000000102",
            valid_from="2026-01-01",
            valid_to="2026-06-30",
        ),
    )
    assert first.status == "accepted"

    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000103",
            "sync-000000000103",
            valid_from="2026-06-01",
            valid_to="2026-08-01",
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "mapping_period_overlap"


def test_mapping_create_accepts_adjacent_periods(service, connection):
    # G2 端点语义：上半年止于 2026-06-30、下半年始于 2026-07-01 是合法衔接，
    # 不算重叠（docs/spec/business-p0p1.md §5.3）。
    _create_customer(service, "op-000000000111", "sync-000000000111")
    first = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000112",
            "sync-000000000112",
            valid_from="2026-01-01",
            valid_to="2026-06-30",
        ),
    )
    assert first.status == "accepted"

    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000113",
            "sync-000000000113",
            valid_from="2026-07-01",
            valid_to=None,
        ),
    )
    assert result.status == "accepted"


def test_mapping_update_rejects_overlap_from_changed_valid_from(service, connection):
    # G2 update 路径：只改 valid_from 造成重叠 → 用「旧记录 ∪ patch」合并后的区间
    # 参与比较并 rejected（docs/spec/business-p0p1.md §5.3/§5.4）。
    _create_customer(service, "op-000000000121", "sync-000000000121")
    service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000122",
            "sync-000000000122",
            valid_from="2026-01-01",
            valid_to="2026-06-30",
        ),
    )
    service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000123",
            "sync-000000000123",
            valid_from="2026-07-01",
            valid_to=None,
        ),
    )

    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000124",
            "sync-000000000123",
            base_version=1,
            fields={"valid_from": "2026-06-01"},
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "mapping_period_overlap"


# ---------- 4. work_order update 路径的合并后跨表校验 ----------


def _seed_order_dependencies(service, connection):
    """前置数据：客户 + 大类（含启用/停用小类）+ 编号映射（2026-08-01..08-12）。"""
    _create_customer(service, "op-000000000201", "sync-000000000201")
    customer_id = _customer_id(connection, "sync-000000000201")
    ServiceCategoriesRepository(connection).apply_Write(
        "13800000000",
        "sync-000000000202",
        {
            "category_name": "洗水",
            "subcategories_json": json.dumps(
                [
                    {"name": "单洗", "default_unit": "件", "is_active": True},
                    {"name": "停用项", "default_unit": "件", "is_active": False},
                ],
                ensure_ascii=False,
            ),
            "is_active": 1,
        },
        0,
    )
    service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000203",
            "sync-000000000203",
            customer_id=customer_id,
            valid_from="2026-08-01",
            valid_to="2026-08-12",
        ),
    )
    return customer_id


def _seed_order(service, connection):
    customer_id = _seed_order_dependencies(service, connection)
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000204",
            "sync-000000000204",
            _make_order_fields(customer_id=customer_id),
            0,
        ),
    )
    assert result.status == "accepted"


def test_work_order_update_service_item_mismatch(service, connection):
    # G4 update 路径：改 service_item 为不属于当前大类的值 → 合并后校验仍拦截，
    # 错误码 service_item_mismatch（docs/error-codes.md §4.2）。
    _seed_order(service, connection)
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000205",
            "sync-000000000204",
            {"service_item": "不存在的项"},
            1,
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "service_item_mismatch"


def test_work_order_update_to_disabled_service_item(service, connection):
    # G4 update 路径：改 service_item 到停用小类 → service_option_disabled
    # （§5.4 明确补上小类 is_active=false 的检查）。
    _seed_order(service, connection)
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000206",
            "sync-000000000204",
            {"service_item": "停用项"},
            1,
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "service_option_disabled"


def test_work_order_update_date_to_unmapped_date(service, connection):
    # G4 update 路径：改 work_order_date 到无映射日期 → 用合并后的日期+编号校验，
    # 错误码 customer_mapping_invalid。
    _seed_order(service, connection)
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000207",
            "sync-000000000204",
            {"work_order_date": "2026-08-13"},
            1,
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "customer_mapping_invalid"


def test_work_order_update_quantity_skips_cross_validation(service, connection):
    # G4 边界：update 只改 quantity → 未触及 service_category/service_item/
    # work_order_date/customer_code/customer_id，不应触发跨表校验。
    _seed_order(service, connection)
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _work_order_op(
            "op-000000000208",
            "sync-000000000204",
            {"quantity": 20},
            1,
        ),
    )
    assert result.status == "accepted"


# ---------- 5. customer_code_mapping 的 customer_id 存在性校验 ----------


def test_mapping_create_rejects_missing_customer(service):
    # G4/G2：映射 create 必须校验 customer_id 存在且未归档，否则 rejected
    # customer_not_found（docs/error-codes.md §4.2）。
    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000301",
            "sync-000000000301",
            customer_id=999,
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "customer_not_found"


def test_mapping_update_rejects_missing_customer_when_present(service, connection):
    # 同一规则在 update 路径：仅当 fields 里出现 customer_id 才查；出现且不存在 → rejected。
    _create_customer(service, "op-000000000311", "sync-000000000311")
    created = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op("op-000000000312", "sync-000000000312", customer_id=1),
    )
    assert created.status == "accepted"

    result = service.execute_Operation(
        "13800000000",
        "dev-a1b2c3d4e5f6",
        _mapping_op(
            "op-000000000313",
            "sync-000000000312",
            base_version=1,
            fields={"customer_id": 999},
        ),
    )
    assert result.status == "rejected"
    assert result.errors[0]["error_code"] == "customer_not_found"
