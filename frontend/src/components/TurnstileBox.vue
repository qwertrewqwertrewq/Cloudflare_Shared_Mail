<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps({
  siteKey: { type: String, required: true },
  modelValue: { type: String, default: "" },
  boxId: { type: String, required: true }
});

const emit = defineEmits(["update:modelValue"]);
const ready = ref(false);
const loading = ref(false);
const errorText = ref("");
const widgetId = ref(null);
const initializing = ref(false);

watch(
  () => props.siteKey,
  async (key) => {
    if (!key) {
      ready.value = false;
      return;
    }
    await init();
  },
  { immediate: true }
);

onBeforeUnmount(() => {
  try {
    if (window.turnstile && widgetId.value !== null) {
      window.turnstile.remove(widgetId.value);
    }
  } catch {
    // noop
  }
});

async function init() {
  if (initializing.value) {
    return;
  }

  initializing.value = true;
  loading.value = true;
  errorText.value = "";
  ready.value = false;
  emit("update:modelValue", "");

  try {
    await waitTurnstile(12000);
    await nextTick();

    const host = document.getElementById(props.boxId);
    if (!host) {
      throw new Error("验证容器不存在");
    }

    host.innerHTML = "";
    widgetId.value = window.turnstile.render(`#${props.boxId}`, {
      sitekey: props.siteKey,
      callback(token) {
        emit("update:modelValue", token);
      },
      "expired-callback"() {
        emit("update:modelValue", "");
      },
      "error-callback"() {
        errorText.value = "人机验证加载失败，请重试。";
        ready.value = false;
      }
    });
    ready.value = true;
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "人机验证加载失败";
    ready.value = false;
  } finally {
    loading.value = false;
    initializing.value = false;
  }
}

function waitTurnstile(timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (window.turnstile && typeof window.turnstile.render === "function") {
        window.clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - started > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error("人机验证加载超时，请刷新页面或检查网络。"));
      }
    }, 50);
  });
}
</script>

<template>
  <div>
    <div :id="boxId"></div>
    <div v-if="loading" class="muted">人机验证加载中...</div>
    <div v-if="errorText" class="muted" style="color: #c0392b; margin-top: 6px">{{ errorText }}</div>
    <button v-if="errorText" type="button" class="retry-btn" @click="init">重试验证加载</button>
    <div v-if="!loading && !errorText && !ready" class="muted">等待验证组件初始化...</div>
  </div>
</template>

<style scoped>
.retry-btn {
  margin-top: 8px;
  border: 1px solid #c7d3ea;
  background: #f6f9ff;
  color: #27446f;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
</style>
