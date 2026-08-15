<script setup lang="ts">
import { computed } from 'vue'
import { prototypeState } from '../../state/prototypeState'

const props = defineProps<{
  categoryName: string
  subcategoryName: string
}>()

const emit = defineEmits<{
  (e: 'update:categoryName', val: string): void
  (e: 'update:subcategoryName', val: string): void
  (e: 'unitChange', defaultUnit: string): void
}>()

const activeCategory = computed(() => {
  return prototypeState.categories.find((c) => c.name === props.categoryName)
})

function selectCategory(catName: string) {
  emit('update:categoryName', catName)
  const cat = prototypeState.categories.find((c) => c.name === catName)
  if (cat && cat.subcategories.length > 0) {
    const firstSub = cat.subcategories[0]
    emit('update:subcategoryName', firstSub.name)
    emit('unitChange', firstSub.defaultUnit)
  }
}

function selectSubcategory(subName: string, defaultUnit: string) {
  emit('update:subcategoryName', subName)
  emit('unitChange', defaultUnit)
}
</script>

<template>
  <div class="cb-category-selector">
    <div class="cb-section-label">服务项目</div>

    <!-- 大类分段导航 -->
    <div class="cb-cat-segmented">
      <button
        v-for="cat in prototypeState.categories"
        :key="cat.categoryId"
        class="cb-segment-btn cb-pressable"
        :class="{ 'cb-segment-btn--active': categoryName === cat.name }"
        @click="selectCategory(cat.name)"
      >
        {{ cat.name }}
      </button>
    </div>

    <!-- 小类药丸平铺 -->
    <div v-if="activeCategory" class="cb-subcat-row">
      <button
        v-for="sub in activeCategory.subcategories"
        :key="sub.name"
        class="cb-subcat-pill cb-pressable"
        :class="{ 'cb-subcat-pill--active': subcategoryName === sub.name }"
        @click="selectSubcategory(sub.name, sub.defaultUnit)"
      >
        <span class="cb-subcat-name">{{ sub.name }}</span>
        <span class="cb-subcat-unit">({{ sub.defaultUnit }})</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.cb-category-selector {
  margin-bottom: 16px;
}

.cb-section-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--cb-text-sub);
  margin-bottom: 8px;
}

.cb-cat-segmented {
  display: flex;
  background: var(--cb-surface-subtle);
  padding: 4px;
  border-radius: var(--cb-radius-md);
  margin-bottom: 10px;
  border: 1px solid var(--cb-border);
}

.cb-segment-btn {
  flex: 1;
  height: 38px;
  background: transparent;
  border: none;
  border-radius: var(--cb-radius-sm);
  font-size: 14px;
  font-weight: 600;
  color: var(--cb-text-sub);
  outline: none;
  transition: all 0.15s ease;
}

.cb-segment-btn--active {
  background: var(--cb-surface);
  color: var(--cb-text-main);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.cb-subcat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.cb-subcat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px;
  background: var(--md-sys-color-surface);
  border: none;
  border-radius: var(--md-sys-shape-corner-medium);
  box-shadow: var(--md-sys-elevation-1);
  font-size: 14px;
  font-weight: 600;
  color: var(--md-sys-color-on-surface);
  outline: none;
  cursor: pointer;
  transition: all var(--md-sys-motion-duration-short) var(--md-sys-motion-easing-standard);
}

.cb-subcat-unit {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
  font-weight: 500;
}

.cb-subcat-pill:hover {
  box-shadow: var(--md-sys-elevation-2);
}

.cb-subcat-pill--active {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  box-shadow: var(--md-sys-elevation-2);
  font-weight: 700;
  border: none;
}

.cb-subcat-pill--active .cb-subcat-unit {
  color: var(--md-sys-color-on-primary-container);
  opacity: 0.85;
}
</style>
