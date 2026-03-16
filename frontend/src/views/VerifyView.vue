<script setup>
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import TurnstileBox from "../components/TurnstileBox.vue";
import { api } from "../services/api";

const route = useRoute();
const router = useRouter();

const code = ref(String(route.query.code || ""));
const captchaToken = ref("");
const siteKey = ref("");
const pathCode = computed(() => String(route.params.path || "").trim());

onMounted(async () => {
  try {
    const config = await api("/api/public/config");
    siteKey.value = config.turnstileSiteKey || "";
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加载验证配置失败");
  }
});

function goList() {
  if (!pathCode.value) {
    ElMessage.error("路径无效");
    return;
  }
  if (!code.value.trim()) {
    ElMessage.error("请输入访问码");
    return;
  }
  if (!captchaToken.value) {
    ElMessage.error("请先完成验证");
    return;
  }

  router.push({
    name: "list",
    params: { path: pathCode.value },
    query: { code: code.value.trim() }
  });
}
</script>

<template>
  <el-card class="shell-card verify-panel">
    <template #header>
      <h2 class="page-title">访问验证</h2>
    </template>

    <el-space direction="vertical" fill :size="14">
      <el-alert type="info" :closable="false" show-icon>
        路径: <strong>{{ pathCode }}</strong>
      </el-alert>

      <el-input v-model="code" type="password" show-password placeholder="请输入访问码" clearable />

      <TurnstileBox box-id="verify-turnstile" :site-key="siteKey" v-model="captchaToken" />

      <el-button type="primary" size="large" @click="goList">进入邮件列表</el-button>
    </el-space>
  </el-card>
</template>
