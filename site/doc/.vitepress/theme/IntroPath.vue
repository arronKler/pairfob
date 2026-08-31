<script setup lang="ts">
import { computed } from "vue";
import { useData } from "vitepress";

type Node = {
  k: string;
  title: string;
  detail: string;
  hop?: string;
  relay?: boolean;
  chain?: string[];
};

const { lang } = useData();
const zh = computed(() => lang.value.startsWith("zh"));

const copy = computed(() =>
  zh.value
    ? {
        aria: "会话从另一台设备经 pairfob.com 到你的电脑",
        nodes: [
          {
            k: "设备",
            title: "另一台设备上的 Pairfob",
            detail: "手机、平板或另一台电脑。密钥在这一端。",
            hop: "密文",
          },
          {
            k: "中转",
            title: "pairfob.com",
            detail: "只转发密文。不看内容，不跑 agent。",
            hop: "密文",
            relay: true,
          },
          {
            k: "电脑",
            title: "你电脑上的 pairfob",
            detail: "接到 Herdr，再接到那些 CLI。",
            chain: ["pairfob", "Herdr", "CLI"],
          },
        ],
      }
    : {
        aria: "A session travels from another device through pairfob.com to your computer",
        nodes: [
          {
            k: "Device",
            title: "Pairfob on another device",
            detail: "Phone, tablet, or another computer. Keys stay here.",
            hop: "ciphertext",
          },
          {
            k: "Relay",
            title: "pairfob.com",
            detail: "Forwards ciphertext. Does not read content or run agents.",
            hop: "ciphertext",
            relay: true,
          },
          {
            k: "Computer",
            title: "pairfob on your computer",
            detail: "Talks to Herdr, then to those CLIs.",
            chain: ["pairfob", "Herdr", "CLI"],
          },
        ],
      },
);
</script>

<template>
  <ol class="pf-rail" :aria-label="copy.aria">
    <li v-for="n in copy.nodes" :key="n.k" :class="{ relay: n.relay }">
      <p class="k">{{ n.k }}</p>
      <p class="t">{{ n.title }}</p>
      <p class="d">{{ n.detail }}</p>
      <p v-if="n.chain" class="chain">
        <span v-for="step in n.chain" :key="step">{{ step }}</span>
      </p>
      <p v-if="n.hop" class="hop">{{ n.hop }}</p>
    </li>
  </ol>
</template>

<style scoped>
.pf-rail {
  list-style: none;
  margin: 24px 0 4px;
  padding: 4px 0 2px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}

.pf-rail li {
  position: relative;
  margin: 0;
  padding: 14px 20px 2px 44px;
}

.pf-rail li:last-child {
  padding-bottom: 18px;
}

.pf-rail li::before {
  content: "";
  position: absolute;
  left: 18px;
  top: 20px;
  width: 9px;
  height: 9px;
  border: 2px solid var(--vp-c-brand-1);
  border-radius: 50%;
  background: var(--vp-c-bg-alt);
}

.pf-rail li.relay::before {
  border-color: var(--vp-c-text-3);
}

.pf-rail li:not(:last-child)::after {
  content: "";
  position: absolute;
  left: 22px;
  top: 31px;
  bottom: 0;
  width: 1px;
  background: var(--vp-c-divider);
}

.k {
  margin: 0 0 2px;
  color: var(--vp-c-text-2);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.1em;
}

.t {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 650;
  line-height: 1.35;
}

.d {
  margin: 4px 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.88rem;
  line-height: 1.55;
  text-wrap: pretty;
}

.relay .t {
  color: var(--vp-c-text-2);
  font-weight: 500;
}

.chain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0 0;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
}

.chain span:not(:last-child)::after {
  content: "→";
  margin-left: 6px;
  color: var(--vp-c-text-3);
}

.hop {
  margin: 10px 0 8px;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.06em;
}
</style>
