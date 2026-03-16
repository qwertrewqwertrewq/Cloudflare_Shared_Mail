<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import TurnstileBox from "../components/TurnstileBox.vue";
import { api, bearer } from "../services/api";

const route = useRoute();
const router = useRouter();

const siteKey = ref("");
const captchaToken = ref("");
const loading = ref(false);
const authed = ref(false);
const previewToken = ref("");
const mailbox = ref("");
const messages = ref([]);
const selectedId = ref("");
const selectedMsg = ref(null);
const autoStarted = ref(false);

const pathCode = computed(() => String(route.params.path || ""));
const code = computed(() => String(route.query.code || ""));

onMounted(async () => {
  try {
    const config = await api("/api/public/config");
    siteKey.value = config.turnstileSiteKey || "";
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加载验证配置失败");
  }
});

watch(captchaToken, async (token) => {
  if (!token) {
    autoStarted.value = false;
    return;
  }
  if (authed.value || loading.value || autoStarted.value) {
    return;
  }
  autoStarted.value = true;
  await startLoad(false);
});

async function startLoad(showNoCaptchaError = true) {
  if (!captchaToken.value) {
    if (showNoCaptchaError) {
      ElMessage.error("请先完成人机验证");
    }
    return;
  }

  loading.value = true;
  try {
    const access = await api("/api/preview/access", {
      method: "POST",
      body: JSON.stringify({
        path: pathCode.value,
        code: code.value,
        turnstileToken: captchaToken.value
      })
    });

    previewToken.value = access.token;
    mailbox.value = access.mailbox;
    authed.value = true;

    const list = await api("/api/preview/messages", {
      headers: bearer(previewToken.value)
    });

    messages.value = list.messages || [];
    if (messages.value.length > 0) {
      await openMessage(messages.value[0].id);
    }
  } catch (err) {
    autoStarted.value = false;
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function openMessage(id) {
  selectedId.value = id;
  const res = await api(`/api/preview/messages/${encodeURIComponent(id)}`, {
    headers: bearer(previewToken.value)
  });
  selectedMsg.value = res.message;
}

function backVerify() {
  router.push({ name: "verify", params: { path: pathCode.value } });
}
</script>

<template>
  <el-card class="shell-card" v-if="!authed">
    <template #header>
      <h2 class="page-title">加载邮箱列表</h2>
    </template>

    <el-space direction="vertical" fill :size="14" class="gate-center">
      <el-alert :closable="false" show-icon class="gate-alert">
        访问路径: <strong>{{ pathCode }}</strong>
      </el-alert>
      <el-alert type="warning" :closable="false" show-icon class="gate-alert">
        检测到访问码参数，完成人机验证后将自动加载。
      </el-alert>
      <TurnstileBox box-id="list-turnstile" :site-key="siteKey" v-model="captchaToken" />
    </el-space>
  </el-card>

  <template v-else>

    <div class="list-layout">
      <el-card class="shell-card list-column">
        <template #header>邮件列表</template>
        <div class="scroll-body">
          <div v-if="messages.length === 0" class="page-note">暂无邮件</div>
          <div
            v-for="item in messages"
            :key="item.id"
            :class="['msg-item', { active: selectedId === item.id }]"
            @click="openMessage(item.id)"
          >
            <p class="msg-subject">{{ item.subject || '(No subject)' }}</p>
            <p class="msg-meta">{{ item.from }} -> {{ item.to }}</p>
            <p class="msg-meta">{{ new Date(item.receivedAt).toLocaleString() }}</p>
          </div>
        </div>
      </el-card>

      <el-card class="shell-card detail-column">
        <template #header>邮件预览</template>
        <div class="scroll-body">
          <template v-if="selectedMsg">
            <h5>{{ selectedMsg.subject || '(No subject)' }}</h5>
            <p class="page-note">From: {{ selectedMsg.from }}</p>
            <p class="page-note">To: {{ selectedMsg.to }}</p>
            <p class="page-note">Received: {{ new Date(selectedMsg.receivedAt).toLocaleString() }}</p>
            <el-divider />
            <div v-if="selectedMsg.html" class="html-preview" v-html="selectedMsg.html"></div>
            <el-divider v-if="selectedMsg.html" />
            <h4>文本内容</h4>
            <el-input type="textarea" :rows="8" :model-value="selectedMsg.text || ''" readonly />
          </template>
          <div v-else class="page-note">请选择一封邮件</div>
        </div>
      </el-card>
    </div>
  </template>
</template>
