import { createRouter, createWebHistory } from "vue-router";
import VerifyView from "../views/VerifyView.vue";
import ListView from "../views/ListView.vue";
import AdminView from "../views/AdminView.vue";

const routes = [
  { path: "/", name: "home", component: AdminView },
  { path: "/verify/:path", name: "verify", component: VerifyView },
  { path: "/list/:path", name: "list", component: ListView },
  { path: "/admin", name: "admin", component: AdminView }
];

const router = createRouter({
  history: createWebHistory(),
  routes
});

router.beforeEach((to) => {
  if (to.name === "list") {
    const code = String(to.query.code || "").trim();
    if (!code) {
      return { name: "verify", params: { path: to.params.path } };
    }
  }
  return true;
});

export default router;
