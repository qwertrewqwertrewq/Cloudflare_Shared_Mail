<script setup>
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import TurnstileBox from "../components/TurnstileBox.vue";
import { api, bearer } from "../services/api";

const adminToken = ref(localStorage.getItem("cfmail_admin_token") || "");
const adminSecret = ref("");
const siteKey = ref("");
const loginCaptcha = ref("");
const mailboxes = ref([]);
const newMailbox = ref("");
const loading = ref(false);

onMounted(async () => {
  try {
    const cfg = await api("/api/public/config");
    siteKey.value = cfg.turnstileSiteKey || "";
    if (adminToken.value) {
      await loadMailboxes();
    }
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "加载验证配置失败");
  }
});

async function login() {
  if (!adminSecret.value.trim()) {
    ElMessage.error("请输入管理员密钥");
    return;
  }
  if (!loginCaptcha.value) {
    ElMessage.error("请完成人机验证");
    return;
  }

  loading.value = true;
  try {
    const res = await api("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ secret: adminSecret.value.trim(), turnstileToken: loginCaptcha.value })
    });
    adminToken.value = res.token;
    localStorage.setItem("cfmail_admin_token", res.token);
    await loadMailboxes();
    ElMessage.success("登录成功");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

async function loadMailboxes() {
  const res = await api("/api/admin/mailboxes", { headers: bearer(adminToken.value) });
  mailboxes.value = (res.mailboxes || []).map((item) => ({ ...item, saving: false }));
}

async function createMailbox() {
  if (!newMailbox.value.trim()) {
    ElMessage.error("请输入邮箱地址");
    return;
  }
  const res = await api("/api/admin/mailboxes", {
    method: "POST",
    headers: bearer(adminToken.value),
    body: JSON.stringify({ email: newMailbox.value.trim() })
  });
  ElMessage.success(`已创建 ${res.mailbox.email}，访问码: ${res.mailbox.accessCode}`);
  newMailbox.value = "";
  await loadMailboxes();
}

async function saveMailbox(row) {
  row.saving = true;
  try {
    await api(`/api/admin/mailboxes/${encodeURIComponent(row.email)}`, {
      method: "PATCH",
      headers: bearer(adminToken.value),
      body: JSON.stringify({ autoDeleteHours: Number(row.autoDeleteHours), maxStored: Number(row.maxStored) })
    });
    ElMessage.success("已保存配置");
    await loadMailboxes();
  } finally {
    row.saving = false;
  }
}

async function rotateMailbox(row) {
  const res = await api(`/api/admin/mailboxes/${encodeURIComponent(row.email)}/rotate`, {
    method: "POST",
    headers: bearer(adminToken.value)
  });
  ElMessage.success(`新访问码: ${res.mailbox.accessCode}`);
  await loadMailboxes();
}

async function copyShareUrl(row) {
  const text = row.shareUrl || row.previewUrl;
  await navigator.clipboard.writeText(text);
  ElMessage.success("分享链接已复制");
}

function logout() {
  adminToken.value = "";
  localStorage.removeItem("cfmail_admin_token");
}
</script>

<template>
  <!-- <div class="admin-login-wrap" v-if="0"> -->
  <div class="admin-login-wrap" v-if="!adminToken">

    <el-card class="shell-card admin-login-card">
      <template #header><h2 class="page-title">管理员登录</h2></template>
      <el-space direction="vertical" fill :size="14" class="admin-login-form">
        <el-input v-model="adminSecret" type="password" show-password placeholder="管理员密钥" />
        <TurnstileBox box-id="admin-turnstile" :site-key="siteKey" v-model="loginCaptcha" />
        <el-button type="primary" :loading="loading" @click="login" class="admin-login-btn">登录</el-button>
      </el-space>
    </el-card>
  </div>

  <template v-else>



    <el-card class="shell-card align-items-center" style="margin-bottom: 12px">
      <el-space class="align-items-between" >
        <el-input v-model="newMailbox" placeholder="name@example.com" style="width: 360px" />
        <el-button type="primary" @click="createMailbox">新增邮箱</el-button>
        <el-button @click="loadMailboxes">刷新</el-button>
        <el-button @click="logout" type="danger">退出登录</el-button>
      </el-space>
    </el-card>

    <el-card class="shell-card admin-shell">
      <template #header>邮箱配置</template>
      <div class="admin-scroll">
        <el-table :data="mailboxes" stripe class="admin-table">
          <el-table-column prop="email" label="邮箱" min-width="220" />
          <el-table-column prop="path" label="路径" max-width="100" />
          <el-table-column prop="accessCode" label="访问码" min-width="130">
            <template #default="scope">
              <span class="code-cell">{{ scope.row.accessCode || "(请刷新路径和码)" }}</span>
            </template>
          </el-table-column>
          <el-table-column label="自动删除(小时)" min-width="150">
            <template #default="scope">
              <el-input-number v-model="scope.row.autoDeleteHours" :min="1" :max="8760" />
            </template>
          </el-table-column>
          <el-table-column label="最大封数" max-width="100">
            <template #default="scope">
              <el-input-number v-model="scope.row.maxStored" :min="1" :max="5000" />
            </template>
          </el-table-column>
          <el-table-column label="分享地址" max-width="100">
            <template #default="scope">
              <el-input :model-value="scope.row.shareUrl || scope.row.previewUrl" readonly />
            </template>
          </el-table-column>
          <el-table-column label="操作" min-width="300" fixed="right">
            <template #default="scope">
              <el-space>
                <el-button size="small" :loading="scope.row.saving" @click="saveMailbox(scope.row)">保存</el-button>
                <el-button size="small" @click="rotateMailbox(scope.row)">刷新路径和码</el-button>
                <el-button size="small" type="primary" @click="copyShareUrl(scope.row)">复制地址</el-button>
              </el-space>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>
  </template>
</template>
