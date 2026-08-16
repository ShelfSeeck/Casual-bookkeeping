"""缝 11：四张业务仓库测试（docs/spec/sync-backend.md §4）。

被测缝：业务仓库的公开接口——get_BySyncId / apply_Write / list_Active。
覆盖每张表的共性契约与各自的本表字段校验（docs/spec/sync-backend.md §4）。
只测公开接口，不碰裸 SQL、不测私有方法。

共性契约（每张表都要验证）：
- get_BySyncId：查无 → None；命中 → 返回记录含 row_version；账户隔离（同 sync_id 不同账户查不到）
- apply_Write create：base_version=0 且记录不存在 → 写入，row_version=1
- apply_Write update：base_version == row_version → 更新字段，row_version+1
- apply_Write 版本不等 → conflict，不写任何变更
- apply_Write 目标不存在 → not_found
- 本表字段校验失败 → rejected
- list_Active：只返回未软删记录（bootstrap 用）

期望值来自 data-model.md 的字面量（如 row_version 初始 1、软删字段名）。
"""

import pytest

from backend.repositories.customers import CustomersRepository
from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository

# ---------- 共享 fixture：一张已存在的客户 + 基础记录 ----------


@pytest.fixture
def customer_repo(connection):
    return CustomersRepository(connection)


def _make_customer_fields():
    return {"canonical_name": "某某厂"}


# ---------- 客户 customers ----------

def test_get_BySyncId_returns_None_when_missing(customer_repo):
    # 空库里查不存在的 sync_id → None，不抛异常
    assert customer_repo.get_BySyncId("13800000000", "sync-000000000001") is None


def test_get_BySyncId_returns_record_with_row_version(customer_repo):
    # create 后用 sync_id 查 → 命中，初始 row_version 应为 1（data-model §5.1）
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    record = customer_repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record is not None
    assert record["canonical_name"] == "某某厂"
    assert record["row_version"] == 1


def test_get_BySyncId_isolates_by_account(customer_repo):
    # 账户隔离：同一 sync_id 在不同账户下互不可见（docs/auth-structure.md §2.1 B 方案）
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    assert customer_repo.get_BySyncId("13900000000", "sync-000000000001") is None


def test_apply_Write_create_sets_row_version_1(customer_repo):
    # create（base_version=0）：记录不存在 → 写入，row_version=1（表默认）
    result = customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    assert result.status == "applied"
    assert result.new_row_version == 1


def test_apply_Write_create_conflicts_when_exists(customer_repo):
    # create 但记录已存在 → 冲突（同一 sync_id 不应重复创建）
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    result = customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    assert result.status == "conflict"


def test_apply_Write_update_bumps_row_version(customer_repo):
    # update：base_version 与当前一致 → 更新字段并递增 row_version
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    result = customer_repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"canonical_name": "新名字", "archived_at": None},
        1,
    )
    assert result.status == "applied"
    assert result.new_row_version == 2
    record = customer_repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["canonical_name"] == "新名字"


def test_apply_Write_update_conflicts_on_stale_base(customer_repo):
    # update 但 base_version(1) != 当前 row_version(2) → 冲突，不写任何变更
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    customer_repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"canonical_name": "第二次", "archived_at": None},
        1,
    )
    result = customer_repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"canonical_name": "第三次", "archived_at": None},
        1,  # 还拿旧版本
    )
    assert result.status == "conflict"
    # 冲突后记录未变（仍是"第二次"）
    record = customer_repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["canonical_name"] == "第二次"
    assert record["row_version"] == 2


def test_apply_Write_update_not_found_when_missing(customer_repo):
    # update 但目标记录不存在 → not_found（docs/error-codes.md entity_not_found）
    result = customer_repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"canonical_name": "新", "archived_at": None},
        1,
    )
    assert result.status == "not_found"


def test_apply_Write_delete_sets_archived_at(customer_repo):
    # delete：软删，置 archived_at 时间戳，不物理删除；row_version 递增
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    result = customer_repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"archived_at": "2026-08-12T00:00:00+00:00"},
        1,
    )
    assert result.status == "applied"
    record = customer_repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["archived_at"] == "2026-08-12T00:00:00+00:00"
    assert record["row_version"] == 2


def test_apply_Write_rejects_empty_canonical_name(customer_repo):
    # 本表校验：客户名称为空 → rejected（docs/error-codes.md invalid_customer_name）
    result = customer_repo.apply_Write(
        "13800000000", "sync-000000000001", {"canonical_name": ""}, 0
    )
    assert result.status == "rejected"


def test_list_Active_excludes_archived(customer_repo):
    # bootstrap 只下载当前在用记录：归档的不应出现在 list_Active
    customer_repo.apply_Write(
        "13800000000", "sync-000000000001", _make_customer_fields(), 0
    )
    customer_repo.apply_Write(
        "13800000000", "sync-000000000002", _make_customer_fields(), 0
    )
    customer_repo.apply_Write(
        "13800000000",
        "sync-000000000002",
        {"archived_at": "2026-08-12T00:00:00+00:00"},
        1,
    )
    active = customer_repo.list_Active("13800000000")
    sync_ids = [r["sync_id"] for r in active]
    assert "sync-000000000001" in sync_ids
    assert "sync-000000000002" not in sync_ids


# ---------- 服务选项 service_categories ----------

def test_service_categories_rejects_duplicate_category_name(connection):
    # 本表校验：同账户内大类重名 → rejected（UNIQUE(account_phone, category_name)）
    repo = ServiceCategoriesRepository(connection)
    repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"category_name": "洗水", "subcategories_json": "[]", "is_active": 1},
        0,
    )
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000002",
        {"category_name": "洗水", "subcategories_json": "[]", "is_active": 1},
        0,
    )
    assert result.status == "rejected"
    # error_code 必须精确为 category_name_duplicate（docs/error-codes.md §4.2），
    # 曾因 ApplyResult 不带错误码而被上层误报为 invalid_subcategories。
    assert result.error_code == "category_name_duplicate"


# 小类结构校验（重名 / 非法 JSON）统一在 test_business_validation.py 缝 15 覆盖，此处不重复。


# ---------- 客户编号映射 customer_code_mappings ----------

def test_mapping_rejects_invalid_period(connection):
    # 本表校验：valid_to < valid_from → rejected（data-model.md §4.4 CHECK）
    repo = CustomerCodeMappingsRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {
            "customer_id": 1,
            "customer_code": "001",
            "customer_name": "甲",
            "valid_from": "2026-08-10",
            "valid_to": "2026-08-01",
        },
        0,
    )
    assert result.status == "rejected"


# ---------- 工单 work_orders ----------

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


def test_order_rejects_non_positive_quantity(connection):
    # 本表校验：数量非正整数 → rejected（docs/error-codes.md invalid_quantity）
    repo = WorkOrdersRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _make_order_fields(quantity=0),
        0,
    )
    assert result.status == "rejected"


def test_order_rejects_negative_unit_price(connection):
    # 本表校验：单价为负 → rejected（docs/error-codes.md invalid_unit_price）
    repo = WorkOrdersRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _make_order_fields(unit_price_cents=-5),
        0,
    )
    assert result.status == "rejected"


def test_order_rejects_null_unit(connection):
    # 本表校验：单位为 null → rejected（invalid_unit），不抛 AttributeError
    repo = WorkOrdersRepository(connection)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        _make_order_fields(unit=None),
        0,
    )
    assert result.status == "rejected"
    assert result.error_code == "invalid_unit"


def test_order_delete_sets_deleted_at(connection):
    # 工单软删：置 deleted_at，不物理删除，row_version 递增
    repo = WorkOrdersRepository(connection)
    repo.apply_Write("13800000000", "sync-000000000001", _make_order_fields(), 0)
    result = repo.apply_Write(
        "13800000000",
        "sync-000000000001",
        {"deleted_at": "2026-08-12T00:00:00+00:00"},
        1,
    )
    assert result.status == "applied"
    record = repo.get_BySyncId("13800000000", "sync-000000000001")
    assert record["deleted_at"] == "2026-08-12T00:00:00+00:00"
    assert record["row_version"] == 2
