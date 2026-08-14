"""缝：BusinessQueryService（docs/spec/agent-tools.md §6 services/business_query.py）。

被测缝：BusinessQueryService 的五个公开查询方法。
通过真实 SQLite 造数（复用四张业务仓库的 apply_Write 公共写口），
断言账户隔离、软删排除、过滤、排序、汇总、limit 收窄与日期容错。
只测服务门面与工具契约字段，不测仓库内部 SQL。
"""

import json

import pytest

from backend.repositories.customer_code_mappings import (
    CustomerCodeMappingsRepository,
)
from backend.repositories.customers import CustomersRepository
from backend.repositories.service_categories import ServiceCategoriesRepository
from backend.repositories.work_orders import WorkOrdersRepository
from backend.services.business_query import BusinessQueryService


@pytest.fixture
def service(connection):
    return BusinessQueryService(
        WorkOrdersRepository(connection),
        CustomersRepository(connection),
        CustomerCodeMappingsRepository(connection),
        ServiceCategoriesRepository(connection),
    )


def _make_order_fields(**overrides):
    fields = {
        "work_order_date": "2026-08-12",
        "created_at": "2026-08-12T10:00:00+00:00",
        "updated_at": "2026-08-12T10:00:00+00:00",
        "customer_id": 1,
        "customer_code": "001",
        "customer_name": "甲",
        "service_category": "洗水",
        "service_item": "单洗",
        "quantity": 10,
        "unit": "件",
        "unit_price_cents": None,
        "is_completed": 0,
        "deleted_at": None,
    }
    fields.update(overrides)
    return fields


def _create_order(repo, account_phone, sync_id, **overrides):
    return repo.apply_Write(account_phone, sync_id, _make_order_fields(**overrides), 0)


def _make_customer_fields(canonical_name):
    return {
        "canonical_name": canonical_name,
        "created_at": "2026-08-01T00:00:00+00:00",
        "updated_at": "2026-08-01T00:00:00+00:00",
    }


# ---------- 工单查询 query_WorkOrders ----------


def test_query_WorkOrders_filters_and_orders(service, connection):
    # 验证：账户隔离 + 软删排除 + 排序（work_order_date DESC, created_at DESC）
    orders = WorkOrdersRepository(connection)
    _create_order(
        orders, "13800000000", "sync-wo-a",
        work_order_date="2026-08-12",
        created_at="2026-08-12T10:00:00+00:00",
    )
    _create_order(
        orders, "13800000000", "sync-wo-b",
        work_order_date="2026-08-13",
        created_at="2026-08-13T09:00:00+00:00",
    )
    _create_order(
        orders, "13800000000", "sync-wo-c",
        work_order_date="2026-08-13",
        created_at="2026-08-13T10:00:00+00:00",
    )
    # 其他账户：同日期也不应可见
    _create_order(
        orders, "13900000000", "sync-wo-other",
        work_order_date="2026-08-13",
        created_at="2026-08-13T11:00:00+00:00",
    )
    # 软删：本账户也不应可见
    _create_order(
        orders, "13800000000", "sync-wo-deleted",
        work_order_date="2026-08-14",
        created_at="2026-08-14T00:00:00+00:00",
    )
    orders.apply_Write(
        "13800000000",
        "sync-wo-deleted",
        {"deleted_at": "2026-08-14T01:00:00+00:00"},
        1,
    )

    result = service.query_WorkOrders("13800000000")
    assert result == {
        "items": [
            {
                "sync_id": "sync-wo-c",
                "work_order_date": "2026-08-13",
                "customer_id": 1,
                "customer_code": "001",
                "customer_name": "甲",
                "service_category": "洗水",
                "service_item": "单洗",
                "quantity": 10,
                "unit": "件",
                "unit_price_cents": None,
                "is_completed": 0,
                "row_version": 1,
            },
            {
                "sync_id": "sync-wo-b",
                "work_order_date": "2026-08-13",
                "customer_id": 1,
                "customer_code": "001",
                "customer_name": "甲",
                "service_category": "洗水",
                "service_item": "单洗",
                "quantity": 10,
                "unit": "件",
                "unit_price_cents": None,
                "is_completed": 0,
                "row_version": 1,
            },
            {
                "sync_id": "sync-wo-a",
                "work_order_date": "2026-08-12",
                "customer_id": 1,
                "customer_code": "001",
                "customer_name": "甲",
                "service_category": "洗水",
                "service_item": "单洗",
                "quantity": 10,
                "unit": "件",
                "unit_price_cents": None,
                "is_completed": 0,
                "row_version": 1,
            },
        ],
        "total": 3,
    }


def test_query_WorkOrders_filters_by_fields(service, connection):
    # 验证：date_from/date_to/customer_code/service_item/is_completed/unpriced_only 过滤
    orders = WorkOrdersRepository(connection)
    _create_order(
        orders, "13800000000", "sync-wo-1",
        work_order_date="2026-08-10",
        customer_code="001", service_item="单洗",
        unit_price_cents=1000, is_completed=0,
    )
    _create_order(
        orders, "13800000000", "sync-wo-2",
        work_order_date="2026-08-11",
        customer_code="002", service_item="烘件",
        unit_price_cents=None, is_completed=1,
    )
    _create_order(
        orders, "13800000000", "sync-wo-3",
        work_order_date="2026-08-12",
        customer_code="002", service_item="单洗",
        unit_price_cents=500, is_completed=1,
    )

    assert service.query_WorkOrders(
        "13800000000", date_from="2026-08-11", date_to="2026-08-11"
    )["total"] == 1
    assert service.query_WorkOrders(
        "13800000000", customer_code="002"
    )["total"] == 2
    assert service.query_WorkOrders(
        "13800000000", service_item="单洗"
    )["total"] == 2
    assert service.query_WorkOrders(
        "13800000000", is_completed=1
    )["total"] == 2
    assert service.query_WorkOrders(
        "13800000000", unpriced_only=True
    )["total"] == 1


def test_query_WorkOrders_clamps_limit_and_respects_offset(service, connection):
    # 验证：limit 防御性收窄到 100；offset 用于翻页；total 不受 limit 影响
    orders = WorkOrdersRepository(connection)
    for i in range(101):
        _create_order(
            orders, "13800000000", f"sync-wo-{i:03d}",
            work_order_date="2026-08-13",
            created_at=f"2026-08-13T10:{i % 60:02d}:00+00:00",
        )

    result = service.query_WorkOrders("13800000000", limit=999)
    assert len(result["items"]) == 100
    assert result["total"] == 101

    page = service.query_WorkOrders("13800000000", limit=1, offset=1)
    assert len(page["items"]) == 1
    assert page["total"] == 101


def test_query_WorkOrders_invalid_date_returns_empty(service):
    # 验证：日期格式非法 → 返回空结果而非抛错（读工具容错）
    assert service.query_WorkOrders("13800000000", date_from="2026/08/10") == {
        "items": [],
        "total": 0,
    }


# ---------- 工单汇总 summarize_WorkOrders ----------


def test_summarize_WorkOrders_counts_and_amounts(service, connection):
    # 验证：汇总只算未软删 + 账户隔离；金额只算已定价，未定价单独计数
    orders = WorkOrdersRepository(connection)
    _create_order(
        orders, "13800000000", "sync-wo-1",
        work_order_date="2026-08-10",
        quantity=10, unit_price_cents=1000,
    )
    _create_order(
        orders, "13800000000", "sync-wo-2",
        work_order_date="2026-08-11",
        quantity=3, unit_price_cents=200,
    )
    _create_order(
        orders, "13800000000", "sync-wo-3",
        work_order_date="2026-08-12",
        quantity=5, unit_price_cents=None,
    )
    _create_order(
        orders, "13800000000", "sync-wo-deleted",
        work_order_date="2026-08-12",
        quantity=999, unit_price_cents=1,
    )
    orders.apply_Write(
        "13800000000",
        "sync-wo-deleted",
        {"deleted_at": "2026-08-12T01:00:00+00:00"},
        1,
    )
    _create_order(
        orders, "13900000000", "sync-wo-other",
        work_order_date="2026-08-12",
        quantity=999, unit_price_cents=999,
    )

    assert service.summarize_WorkOrders("13800000000") == {
        "work_order_count": 3,
        "total_quantity": 18,
        "priced_count": 2,
        "priced_amount_cents": 10600,
        "unpriced_count": 1,
    }


def test_summarize_WorkOrders_invalid_date_returns_zero(service):
    # 验证：日期格式非法 → 汇总各项为 0，不抛错
    assert service.summarize_WorkOrders("13800000000", date_from="2026-08-10T00:00:00") == {
        "work_order_count": 0,
        "total_quantity": 0,
        "priced_count": 0,
        "priced_amount_cents": 0,
        "unpriced_count": 0,
    }


# ---------- 客户查询 query_Customers ----------


def test_query_Customers_keyword_and_archive_filter(service, connection):
    # 验证：默认排除归档客户；keyword 模糊匹配 canonical_name；include_archived 才含归档
    customers = CustomersRepository(connection)
    customers.apply_Write(
        "13800000000", "sync-c-1",
        _make_customer_fields("广州阿强制衣厂"), 0,
    )
    customers.apply_Write(
        "13800000000", "sync-c-2",
        _make_customer_fields("深圳洗水厂"), 0,
    )
    customers.apply_Write(
        "13800000000", "sync-c-3",
        _make_customer_fields("阿强旧厂"), 0,
    )
    customers.apply_Write(
        "13800000000", "sync-c-3",
        {"archived_at": "2026-08-02T00:00:00+00:00"}, 1,
    )
    customers.apply_Write(
        "13900000000", "sync-c-other",
        _make_customer_fields("阿强他厂"), 0,
    )

    active = service.query_Customers("13800000000")
    assert active["total"] == 2
    assert {item["sync_id"] for item in active["items"]} == {"sync-c-1", "sync-c-2"}
    assert active["items"][0].keys() == {
        "customer_id", "sync_id", "canonical_name", "archived_at",
    }
    assert all(item["archived_at"] is None for item in active["items"])

    matched = service.query_Customers("13800000000", keyword="阿强")
    assert matched["total"] == 1
    assert matched["items"][0]["sync_id"] == "sync-c-1"

    with_archived = service.query_Customers(
        "13800000000", keyword="阿强", include_archived=True
    )
    assert with_archived["total"] == 2


def test_query_Customers_invalid_limit_clamped(service, connection):
    # 验证：limit 超过上限时收窄，不报错（防御性）
    customers = CustomersRepository(connection)
    for i in range(3):
        customers.apply_Write(
            "13800000000", f"sync-c-{i}",
            _make_customer_fields(f"客户{i}"), 0,
        )
    result = service.query_Customers("13800000000", limit=999)
    assert len(result["items"]) == 3
    assert result["total"] == 3


# ---------- 编号映射查询 query_CustomerCodeMappings ----------


def test_query_CustomerCodeMappings_filters_by_code_and_date(service, connection):
    # 验证：customer_code 精确过滤 + on_date 按有效期间匹配 + 账户隔离 + 字段形状
    mappings = CustomerCodeMappingsRepository(connection)
    mappings.apply_Write(
        "13800000000", "sync-m-1",
        {
            "customer_id": 1, "customer_code": "001", "customer_name": "甲",
            "valid_from": "2026-08-01", "valid_to": None,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    mappings.apply_Write(
        "13800000000", "sync-m-2",
        {
            "customer_id": 2, "customer_code": "002", "customer_name": "乙",
            "valid_from": "2026-01-01", "valid_to": "2026-12-31",
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
        },
        0,
    )
    mappings.apply_Write(
        "13900000000", "sync-m-other",
        {
            "customer_id": 3, "customer_code": "001", "customer_name": "丙",
            "valid_from": "2026-08-01", "valid_to": None,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )

    on_june = service.query_CustomerCodeMappings("13800000000", on_date="2026-06-01")
    assert on_june["total"] == 1
    assert on_june["items"][0]["sync_id"] == "sync-m-2"
    assert on_june["items"][0].keys() == {
        "mapping_id", "sync_id", "customer_id", "customer_code",
        "customer_name", "valid_from", "valid_to",
    }

    code_001 = service.query_CustomerCodeMappings("13800000000", customer_code="001")
    assert code_001["total"] == 1

    on_sept = service.query_CustomerCodeMappings("13800000000", on_date="2026-09-01")
    assert on_sept["total"] == 2


def test_query_CustomerCodeMappings_invalid_on_date_returns_empty(service):
    # 验证：on_date 非法 → 空结果，不抛错
    assert service.query_CustomerCodeMappings(
        "13800000000", on_date="not-a-date"
    ) == {"items": [], "total": 0}


# ---------- 服务选项查询 query_ServiceCategories ----------


def test_query_ServiceCategories_parses_subcategories_and_filters_inactive(service, connection):
    # 验证：默认只返回启用大类；subcategories_json 解析为列表；include_inactive 才含停用
    categories = ServiceCategoriesRepository(connection)
    categories.apply_Write(
        "13800000000", "sync-sc-1",
        {
            "category_name": "洗水",
            "subcategories_json": json.dumps(
                [{"name": "单洗", "default_unit": "件", "is_active": True}],
                ensure_ascii=False,
            ),
            "is_active": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    categories.apply_Write(
        "13800000000", "sync-sc-2",
        {
            "category_name": "刷毛",
            "subcategories_json": json.dumps(
                [{"name": "背心", "default_unit": "件", "is_active": False}],
                ensure_ascii=False,
            ),
            "is_active": 0,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )
    categories.apply_Write(
        "13900000000", "sync-sc-other",
        {
            "category_name": "洗水",
            "subcategories_json": "[]",
            "is_active": 1,
            "created_at": "2026-08-01T00:00:00+00:00",
            "updated_at": "2026-08-01T00:00:00+00:00",
        },
        0,
    )

    active = service.query_ServiceCategories("13800000000")
    assert len(active["items"]) == 1
    item = active["items"][0]
    assert item["sync_id"] == "sync-sc-1"
    assert item["category_name"] == "洗水"
    assert item["is_active"] == 1
    assert item["subcategories"] == [
        {"name": "单洗", "default_unit": "件", "is_active": True}
    ]
    assert set(item.keys()) == {
        "sync_id", "category_name", "subcategories", "is_active",
    }

    all_categories = service.query_ServiceCategories(
        "13800000000", include_inactive=True
    )
    assert len(all_categories["items"]) == 2
