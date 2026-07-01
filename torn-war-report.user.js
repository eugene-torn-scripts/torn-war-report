// ==UserScript==
// @name         Torn War Report
// @namespace    https://github.com/eugene-torn-scripts/torn-war-report
// @version      1.1.1
// @description  Per-member ranked-war report for your faction — war hits, outside hits, respect, and how many times each member was hit back. Pick any of your faction's finished wars.
// @author       lannav
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.torn.com
// @license      GPL-3.0-or-later
// @downloadURL  https://update.greasyfork.org/scripts/585104/Torn%20War%20Report.user.js
// @updateURL    https://update.greasyfork.org/scripts/585104/Torn%20War%20Report.meta.js
// ==/UserScript==

/*
 * Torn War Report
 * Copyright (C) 2026 lannav
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details: https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Source: https://github.com/eugene-torn-scripts/torn-war-report
 */

/* eslint-disable no-undef */

(function () {
    "use strict";

    // ════════════════════════════════════════════════════════════
    //  CONSTANTS & CONFIG
    // ════════════════════════════════════════════════════════════

    const VERSION = "1.1.1";

    const API_BASE = "https://api.torn.com/v2";
    // Pace requests well under Torn's 100/min ceiling. A full war is many
    // pages; 700 ms keeps us at ~85/min with headroom for the 60 s cooldown.
    const API_DELAY_MS = 700;
    const RATE_LIMIT_COOLDOWN_MS = 60_000;
    const RATE_LIMIT_ERROR_CODE = 5;
    // Torn returns this when the key lacks faction "API access" permission
    // (or the faction resource isn't readable for this member's position).
    const NO_ACCESS_ERROR_CODE = 7;
    const ATTACKS_PAGE_LIMIT = 100;
    // Hard cap so a runaway cursor can never loop forever. A very long war
    // is a few hundred pages at most.
    const MAX_ATTACK_PAGES = 600;

    // Attack results where the ATTACKER defeated the defender. Everything
    // else (Lost / Stalemate / Escape / Timeout / Interrupted / Assist /
    // None) is a failed or non-scoring attempt.
    const WIN_RESULTS = new Set([
        "Attacked", "Mugged", "Hospitalized", "Arrested", "Looted", "Special", "Bounty",
    ]);

    const LS = {
        apiKey: "twr_apiKey",
    };

    const IS_PDA = typeof PDA_httpGet === "function";
    const GM_XHR = (typeof GM_xmlhttpRequest !== "undefined") ? GM_xmlhttpRequest : null;

    // ════════════════════════════════════════════════════════════
    //  UTILITIES
    // ════════════════════════════════════════════════════════════

    const fmt = {
        num(n) { return n == null ? "0" : Number(n).toLocaleString(); },
        respect(n) {
            if (n == null || !isFinite(n)) return "0";
            return Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
        },
        date(ts) { return new Date(ts * 1000).toLocaleDateString(); },
        dateTime(ts) {
            const d = new Date(ts * 1000);
            return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        },
        dur(secs) {
            if (!secs || secs < 0) return "—";
            const h = Math.floor(secs / 3600);
            const m = Math.floor((secs % 3600) / 60);
            return h > 0 ? `${h}h ${m}m` : `${m}m`;
        },
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function escapeHtml(s) {
        return String(s ?? "").replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    // Torn's pagination `next` link is a full URL WITHOUT the key. Pull its
    // query params (from/to/sort/limit) so we continue on Torn's own cursor
    // rather than guessing timestamps (which risks skipping same-second hits).
    function paramsFromNextLink(nextUrl) {
        try {
            const u = new URL(nextUrl);
            const p = {};
            for (const [k, v] of u.searchParams) if (k !== "key") p[k] = v;
            return p;
        } catch {
            return null;
        }
    }

    // ════════════════════════════════════════════════════════════
    //  KEY RESOLVER
    //  PDA injects the key via a template placeholder at load time.
    // ════════════════════════════════════════════════════════════

    const KeyResolver = {
        resolve() {
            const PDA_KEY = "###PDA-APIKEY###";
            const PLACEHOLDER = "###" + "PDA-APIKEY" + "###";
            if (PDA_KEY !== PLACEHOLDER && /^[A-Za-z0-9]{16}$/.test(PDA_KEY)) return PDA_KEY;
            // Only this script's own key — don't borrow other eugene-scripts'
            // keys, they may be public-scope and can't read the attack log.
            const own = (localStorage.getItem(LS.apiKey) || "").trim();
            if (/^[A-Za-z0-9]{16}$/.test(own)) return own;
            return "";
        },
        save(key) {
            const t = (key || "").trim();
            if (!/^[A-Za-z0-9]{16}$/.test(t)) throw new Error("Torn API key must be 16 alphanumeric characters");
            localStorage.setItem(LS.apiKey, t);
        },
        clear() { localStorage.removeItem(LS.apiKey); },
    };

    // ════════════════════════════════════════════════════════════
    //  API CLIENT — single serialized queue with rate-limit survival.
    //  On error 5 the whole queue pauses for the cooldown and resumes
    //  the exact same request, so a long fetch never loses its place.
    // ════════════════════════════════════════════════════════════

    class TornAPI {
        constructor(key) {
            this.key = key;
            this._queue = Promise.resolve();
            this._lastReq = 0;
            this.onRateLimit = null; // fn({ type:"cooldown"|"resume", remainingMs })
        }
        setKey(k) { this.key = k; }

        _enqueue(fn) {
            const next = this._queue.then(async () => {
                const wait = API_DELAY_MS - (Date.now() - this._lastReq);
                if (wait > 0) await sleep(wait);
                this._lastReq = Date.now();
                return fn();
            });
            this._queue = next.catch(() => {});
            return next;
        }

        async _getJson(url) {
            if (IS_PDA && !GM_XHR) {
                // PDA native bridge — one-arg form only (see workspace notes).
                const raw = await PDA_httpGet(url);
                const text = typeof raw === "string" ? raw : (raw && raw.responseText) || "";
                return JSON.parse(text);
            }
            if (GM_XHR) {
                return new Promise((resolve, reject) => {
                    GM_XHR({
                        method: "GET",
                        url,
                        onload: (res) => {
                            try { resolve(JSON.parse(res.responseText)); }
                            catch (e) { reject(e); }
                        },
                        onerror: () => reject(new Error("network error")),
                        ontimeout: () => reject(new Error("timeout")),
                    });
                });
            }
            const res = await fetch(url);
            return res.json();
        }

        async get(path, params = {}) {
            return this._enqueue(async () => {
                const url = new URL(API_BASE + path);
                for (const [k, v] of Object.entries(params)) {
                    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
                }
                url.searchParams.set("key", this.key);
                while (true) {
                    const data = await this._getJson(url.toString());
                    if (data && data.error && data.error.code === RATE_LIMIT_ERROR_CODE) {
                        this.onRateLimit?.({ type: "cooldown", remainingMs: RATE_LIMIT_COOLDOWN_MS });
                        await sleep(RATE_LIMIT_COOLDOWN_MS);
                        this.onRateLimit?.({ type: "resume" });
                        continue;
                    }
                    if (data && data.error) {
                        const err = new Error(`${data.error.code}: ${data.error.error}`);
                        err.code = data.error.code;
                        throw err;
                    }
                    return data;
                }
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    //  WAR SERVICE — all Torn calls + aggregation for one war.
    // ════════════════════════════════════════════════════════════

    class WarService {
        constructor(api) {
            this.api = api;
            this.ourFaction = null;   // { id, name }
        }

        async loadOurFaction() {
            if (this.ourFaction) return this.ourFaction;
            const d = await this.api.get("/faction/basic");
            const b = d.basic || d;
            this.ourFaction = { id: b.id, name: b.name };
            return this.ourFaction;
        }

        // Ranked-war history for our faction (Public scope). Only wars that
        // have concluded (end > 0) are usable — an ongoing war has no final
        // report and only a partial attack log.
        async loadWars() {
            const our = await this.loadOurFaction();
            const d = await this.api.get("/faction/rankedwars", { limit: 100, sort: "DESC" });
            const wars = (d.rankedwars || [])
                .filter((w) => w.end && w.end > 0)
                .map((w) => {
                    const enemy = (w.factions || []).find((f) => f.id !== our.id) || {};
                    const outcome = w.winner == null ? "draw"
                        : (w.winner === our.id ? "won" : "lost");
                    return {
                        id: w.id,
                        start: w.start,
                        end: w.end,
                        enemyId: enemy.id,
                        enemyName: enemy.name || "Unknown",
                        outcome,
                    };
                });
            return wars;
        }

        async loadReport(warId) {
            const d = await this.api.get(`/faction/${warId}/rankedwarreport`);
            return d.rankedwarreport;
        }

        // Walk the faction attack log across the war window, following Torn's
        // own `next` cursor. Deduped by attack id. onPage(pageNo, total).
        async loadAttacks(from, to, onPage) {
            const byId = new Map();
            let params = { limit: ATTACKS_PAGE_LIMIT, sort: "ASC", from, to };
            let page = 0;
            while (page < MAX_ATTACK_PAGES) {
                const before = byId.size;
                const data = await this.api.get("/faction/attacks", params);
                const batch = data.attacks || [];
                for (const a of batch) byId.set(a.id, a);
                page++;
                onPage?.(page, byId.size);
                // Torn keeps handing back a non-null `next` link even after the
                // window is exhausted, re-serving the final page forever. Stop
                // as soon as a page adds nothing new — that's true convergence.
                if (batch.length === 0 || byId.size === before) break;
                const nextLink = data._metadata && data._metadata.links && data._metadata.links.next;
                if (!nextLink) break;
                const nextParams = paramsFromNextLink(nextLink);
                if (!nextParams) break;
                params = nextParams;
            }
            return [...byId.values()];
        }

        // Reduce report + attack log into per-member rows for our side, plus
        // an enemy summary (report-only — their attack log isn't readable).
        aggregate(report, attacks, ourFactionId) {
            const ourReport = (report.factions || []).find((f) => f.id === ourFactionId) || { members: [] };
            const enemyReport = (report.factions || []).find((f) => f.id !== ourFactionId) || { members: [] };

            const rows = new Map(); // memberId -> row
            const row = (id, name, level) => {
                let r = rows.get(id);
                if (!r) {
                    r = {
                        id, name: name || String(id), level: level || 0,
                        warHits: 0, warAtt: 0, outHits: 0, outAtt: 0, respect: 0,
                        faced: 0, hitBack: 0, defended: 0,
                    };
                    rows.set(id, r);
                }
                if (name) r.name = name;
                if (level) r.level = level;
                return r;
            };

            // Seed from the official report so members who never showed up in
            // the sampled attack pages still appear (with report war counts).
            for (const m of ourReport.members || []) row(m.id, m.name, m.level);

            for (const a of attacks) {
                const atk = a.attacker;
                const def = a.defender;
                const win = WIN_RESULTS.has(a.result);

                if (atk && atk.faction && atk.faction.id === ourFactionId) {
                    const r = row(atk.id, atk.name, atk.level);
                    if (a.is_ranked_war) {
                        r.warAtt++;
                        if (win) r.warHits++;
                    } else {
                        r.outAtt++;
                        if (win) r.outHits++;
                    }
                    if (win && typeof a.respect_gain === "number") r.respect += a.respect_gain;
                }

                if (def && def.faction && def.faction.id === ourFactionId) {
                    const r = row(def.id, def.name, def.level);
                    r.faced++;
                    if (win) r.hitBack++;   // enemy attacker succeeded → our member was hit
                    else r.defended++;      // attacker failed → our member held
                }
            }

            const ourRows = [...rows.values()];

            const enemyRows = (enemyReport.members || []).map((m) => ({
                id: m.id, name: m.name, level: m.level, attacks: m.attacks, score: m.score,
            }));

            return {
                our: {
                    id: ourReport.id, name: ourReport.name,
                    score: ourReport.score, attacks: ourReport.attacks, rows: ourRows,
                },
                enemy: {
                    id: enemyReport.id, name: enemyReport.name,
                    score: enemyReport.score, attacks: enemyReport.attacks, rows: enemyRows,
                },
                winner: report.winner,
                forfeit: report.forfeit,
                start: report.start,
                end: report.end,
            };
        }
    }

    // ════════════════════════════════════════════════════════════
    //  FOOTER MENU (shared eugene-scripts registry) — verbatim module.
    // ════════════════════════════════════════════════════════════

    (function setupEugFooterMenu() {
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        if (W.__eugFooterMenuLoaded) return;
        W.__eugFooterMenuLoaded = true;
        W.__eugeneScripts = W.__eugeneScripts || [];

        const ROW_ID = "eug-footer-row";

        function injectCSS() {
            if (document.getElementById("eug-footer-style")) return;
            const style = document.createElement("style");
            style.id = "eug-footer-style";
            style.textContent = `
[data-eug="menu"]{background:linear-gradient(to bottom,#444,#2a2a2a)!important}
[data-eug="menu"]:hover{background:linear-gradient(to bottom,#555,#333)!important}
#${ROW_ID}{display:none;position:fixed;padding:4px;
  background:rgba(20,20,20,0.96);border:1px solid #444;border-radius:6px;
  gap:4px;z-index:2147483647;white-space:nowrap;pointer-events:auto}
#${ROW_ID}.eug-open{display:flex;flex-direction:row}
`;
            document.head.appendChild(style);
        }

        function injectEntryCSS(entry) {
            if (!entry.color) return;
            const id = `eug-color-${entry.id}`;
            const existing = document.getElementById(id);
            const dark = entry.colorDark || "#222";
            const hover = entry.hoverColor || entry.color;
            const css = `
[data-eug-id="${entry.id}"]{background:linear-gradient(to bottom, ${entry.color}, ${dark})!important}
[data-eug-id="${entry.id}"]:hover{background:linear-gradient(to bottom, ${hover}, ${entry.color})!important}
`;
            if (existing) { existing.textContent = css; return; }
            const el = document.createElement("style");
            el.id = id;
            el.textContent = css;
            document.head.appendChild(el);
        }

        function findRefBtn() {
            return document.getElementById("notes_panel_button")
                || document.getElementById("people_panel_button");
        }

        function getRow() { return document.getElementById(ROW_ID); }
        function closeRow() { const r = getRow(); if (r) r.classList.remove("eug-open"); }

        function openRow(menuBtn) {
            const row = getRow();
            if (!row) return;
            const rect = menuBtn.getBoundingClientRect();
            row.classList.add("eug-open");
            const rowRect = row.getBoundingClientRect();
            const gap = 6;
            const centerX = rect.left + rect.width / 2;
            let left = centerX - rowRect.width / 2;
            const maxLeft = window.innerWidth - rowRect.width - 4;
            left = Math.max(4, Math.min(left, maxLeft));
            row.style.left = left + "px";
            row.style.bottom = (window.innerHeight - rect.top + gap) + "px";
        }

        function makeScriptBtn(entry, refBtn, role) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = entry.name;
            btn.setAttribute("data-eug", role);
            btn.setAttribute("data-eug-id", entry.id);
            const svg = (entry.iconSVG || "").replace(/<svg\b([^>]*)>/, (match, attrs) =>
                /\sclass\s*=/.test(attrs) ? match : `<svg${attrs} class="${iconClasses}">`);
            btn.innerHTML = svg;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeRow();
                try { entry.onClick(); } catch { /* noop */ }
            });
            injectEntryCSS(entry);
            return btn;
        }

        function makeMenuBtn(refBtn) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = "My userscripts";
            btn.setAttribute("data-eug", "menu");
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" class="${iconClasses}">
                <defs><linearGradient id="eug_menu_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
                    <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
                </linearGradient></defs>
                <g fill="url(#eug_menu_grad)">
                    <circle cx="5" cy="12" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="19" cy="12" r="2"/>
                </g>
            </svg>`;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const row = getRow();
                if (row && row.classList.contains("eug-open")) closeRow();
                else openRow(btn);
            });
            return btn;
        }

        const LEGACY_BUTTON_IDS = ["tat-footer-btn", "spa-footer-btn"];

        function render() {
            const refBtn = findRefBtn();
            if (!refBtn) return false;
            injectCSS();

            const parent = refBtn.parentNode;
            parent.querySelectorAll('[data-eug]').forEach((el) => el.remove());
            LEGACY_BUTTON_IDS.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.remove();
            });
            const oldRow = getRow();
            if (oldRow) oldRow.remove();

            const scripts = W.__eugeneScripts || [];
            if (scripts.length === 0) return true;

            if (scripts.length === 1) {
                parent.insertBefore(makeScriptBtn(scripts[0], refBtn, "solo"), refBtn);
            } else {
                const menuBtn = makeMenuBtn(refBtn);
                parent.insertBefore(menuBtn, refBtn);
                const row = document.createElement("div");
                row.id = ROW_ID;
                row.setAttribute("data-eug-row", "");
                for (const s of scripts) row.appendChild(makeScriptBtn(s, refBtn, "item"));
                document.body.appendChild(row);
            }
            return true;
        }

        function mount() {
            render();
            let pending = false;
            const obs = new MutationObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    const refBtn = findRefBtn();
                    if (refBtn && !refBtn.parentNode.querySelector('[data-eug]')) render();
                });
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        W.addEventListener("eugene-scripts-updated", render);
        document.addEventListener("click", (e) => {
            const row = getRow();
            if (!row || !row.classList.contains("eug-open")) return;
            const menuBtn = document.querySelector('[data-eug="menu"]');
            if (menuBtn && menuBtn.contains(e.target)) return;
            if (row.contains(e.target)) return;
            closeRow();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRow(); });
        W.addEventListener("scroll", closeRow, { passive: true });
        W.addEventListener("resize", closeRow);

        W.registerEugeneScript = function (entry) {
            const list = W.__eugeneScripts;
            const i = list.findIndex((s) => s.id === entry.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            W.dispatchEvent(new CustomEvent("eugene-scripts-updated"));
        };
        W.mountEugeneFooterMenu = mount;
    })();

    // ════════════════════════════════════════════════════════════
    //  UI
    // ════════════════════════════════════════════════════════════

    const UI_CSS = `
#twr-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:2147483646;display:none}
#twr-overlay.twr-open{display:flex;align-items:flex-start;justify-content:center;padding:40px 16px 16px}
#twr-panel{background:#1b1b1b;color:#ddd;border:1px solid #333;border-radius:8px;
    width:min(1100px,100%);max-height:calc(100vh - 56px);display:flex;flex-direction:column;
    font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.5)}
#twr-panel h2{margin:0;padding:12px 16px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px;font-size:15px;flex-wrap:wrap}
#twr-panel .twr-close{margin-left:auto;background:none;border:0;color:#aaa;font-size:20px;cursor:pointer}
#twr-tabs{display:flex;gap:0;border-bottom:1px solid #333;background:#141414}
#twr-tabs button{flex:0 0 auto;padding:10px 16px;background:none;border:0;color:#aaa;cursor:pointer;border-bottom:2px solid transparent;font-size:13px}
#twr-tabs button.twr-active{color:#fff;border-bottom-color:#c0392b}
#twr-body{flex:1;overflow:auto;padding:12px 16px}
#twr-body table{width:100%;border-collapse:collapse;font-size:12px;color:#ddd}
#twr-body th,#twr-body td{text-align:right;padding:6px 8px;border-bottom:1px solid #2a2a2a;white-space:nowrap;color:#ddd}
#twr-body th:first-child,#twr-body td:first-child{text-align:left}
#twr-body th{background:#222;color:#bbb;cursor:pointer;user-select:none;position:sticky;top:0}
#twr-body th.twr-nosort{cursor:default}
#twr-body tr.twr-total td{font-weight:600;color:#fff;border-top:2px solid #444;background:#1f1f1f}
#twr-body tr.twr-row:hover{background:#242424}
.twr-controls{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
.twr-controls select{background:#141414;color:#ddd;border:1px solid #333;padding:6px 8px;border-radius:4px;min-width:280px;max-width:100%}
.twr-btn{background:#2a2a2a;color:#ddd;border:1px solid #444;padding:6px 12px;border-radius:4px;cursor:pointer}
.twr-btn:hover{background:#333}
.twr-btn.twr-primary{background:#c0392b;border-color:#c0392b;color:#fff}
.twr-btn:disabled{opacity:0.5;cursor:not-allowed}
.twr-warn{background:#2a2213;border:1px solid #5a4a1a;color:#d8c48a;border-radius:4px;padding:8px 10px;font-size:11px;margin-bottom:10px}
.twr-empty{padding:40px;text-align:center;color:#888}
.twr-outcome{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;background:#141414;border:1px solid #2a2a2a;border-radius:6px}
.twr-outcome .twr-score{font-size:18px;font-weight:700;color:#fff}
.twr-badge{padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700}
.twr-badge.won{background:#1e4620;color:#8fe08f}
.twr-badge.lost{background:#4a1e1e;color:#e08f8f}
.twr-badge.draw{background:#3a3a3a;color:#ccc}
.twr-sub{color:#888;font-size:11px}
.twr-sech{margin:18px 0 6px;font-size:13px;color:#c0392b}
.twr-status{font-size:11px;color:#888;padding:4px 16px;border-top:1px solid #333;background:#141414}
#twr-progress{display:none;padding:6px 16px;border-top:1px solid #333;background:#141414;font-size:11px;color:#bbb}
#twr-progress.twr-visible{display:block}
.twr-bar{position:relative;height:6px;background:#2a2a2a;border-radius:3px;overflow:hidden;margin-bottom:4px}
.twr-bar-fill{position:absolute;top:0;left:0;height:100%;background:linear-gradient(90deg,#c0392b,#e0574a);transition:width 0.3s ease}
.twr-bar.twr-indeterminate .twr-bar-fill{width:40%!important;animation:twr-slide 1.4s ease-in-out infinite}
@keyframes twr-slide{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
.twr-auth{max-width:520px;margin:24px auto;text-align:center}
.twr-auth h3{margin:0 0 8px;color:#fff}
.twr-auth p{color:#bbb;margin:8px 0}
.twr-auth input{width:100%;box-sizing:border-box;background:#141414;color:#ddd;border:1px solid #333;padding:8px 10px;border-radius:4px;margin:8px 0}
.twr-auth .twr-err{color:#e08f8f;min-height:16px;font-size:12px}
.twr-note{color:#888;font-size:11px;margin-top:12px;text-align:left;background:#141414;border:1px solid #2a2a2a;border-radius:4px;padding:10px}
.twr-kk{color:#c0392b}
`;

    class UI {
        constructor(svc) {
            this.svc = svc;
            this.api = svc.api;
            this.activeTab = "report";
            this.wars = null;
            this.selectedWarId = null;
            this.result = null;       // aggregated report currently shown
            this.genError = null;     // last generate() failure to surface
            this.generating = false;
            this.sortBy = "total";
            this.sortDir = "desc";
            this._el = null;
            this._cooldownTimer = null;
        }

        inject() {
            if (document.getElementById("twr-style")) return;
            const s = document.createElement("style");
            s.id = "twr-style";
            s.textContent = UI_CSS;
            document.head.appendChild(s);

            const overlay = document.createElement("div");
            overlay.id = "twr-overlay";
            overlay.innerHTML = `
                <div id="twr-panel" role="dialog" aria-modal="true">
                    <h2>
                        Torn War Report
                        <span style="color:#888;font-size:11px;font-weight:400">v${VERSION}</span>
                        <span style="color:#888;font-size:11px;font-weight:400;margin-left:10px">
                            Like the script? Send a Xanax to
                            <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank"
                               style="color:#cc3333;text-decoration:none">eugene_s [4192025]</a>
                        </span>
                        <button class="twr-close" aria-label="close">&times;</button>
                    </h2>
                    <div id="twr-tabs">
                        <button data-tab="report" class="twr-active">War Report</button>
                        <button data-tab="settings">Settings</button>
                    </div>
                    <div id="twr-body"></div>
                    <div id="twr-progress">
                        <div class="twr-bar" id="twr-bar"><div class="twr-bar-fill" id="twr-bar-fill"></div></div>
                        <div id="twr-progress-text"></div>
                    </div>
                    <div class="twr-status" id="twr-status">—</div>
                </div>
            `;
            overlay.addEventListener("click", (e) => { if (e.target === overlay) this.toggle(false); });
            overlay.querySelector(".twr-close").addEventListener("click", () => this.toggle(false));
            overlay.querySelectorAll("#twr-tabs button").forEach((b) => {
                b.addEventListener("click", () => this.switchTab(b.dataset.tab));
            });
            document.body.appendChild(overlay);
            this._el = overlay;
            this._wireRateLimit();
        }

        toggle(open) {
            if (!this._el) return;
            const should = open ?? !this._el.classList.contains("twr-open");
            this._el.classList.toggle("twr-open", should);
            if (should) this.onOpen();
        }

        setStatus(t) {
            const el = this._el?.querySelector("#twr-status");
            if (el) el.textContent = t;
        }

        switchTab(tab) {
            this.activeTab = tab;
            this._el.querySelectorAll("#twr-tabs button").forEach((b) => {
                b.classList.toggle("twr-active", b.dataset.tab === tab);
            });
            this.render();
        }

        _wireRateLimit() {
            this.api.onRateLimit = (ev) => {
                if (ev.type === "cooldown") {
                    const totalMs = ev.remainingMs;
                    const startedAt = Date.now();
                    this._cooldownTimer && clearInterval(this._cooldownTimer);
                    const tick = () => {
                        const left = Math.max(0, totalMs - (Date.now() - startedAt));
                        const secs = Math.ceil(left / 1000);
                        const pct = Math.round(((totalMs - left) / totalMs) * 100);
                        this._showProgress(
                            `⏸ <b>Rate-limited</b> by Torn — resuming in <b>${secs}s</b>`, pct, false);
                        this.setStatus(`Rate-limited — resuming in ${secs}s…`);
                        if (left <= 0) clearInterval(this._cooldownTimer);
                    };
                    this._cooldownTimer = setInterval(tick, 250);
                    tick();
                } else if (ev.type === "resume") {
                    this._cooldownTimer && clearInterval(this._cooldownTimer);
                    this.setStatus("Resuming fetch…");
                }
            };
        }

        _showProgress(html, pct, indeterminate) {
            const p = this._el.querySelector("#twr-progress");
            const bar = this._el.querySelector("#twr-bar");
            const fill = this._el.querySelector("#twr-bar-fill");
            const txt = this._el.querySelector("#twr-progress-text");
            p.classList.add("twr-visible");
            bar.classList.toggle("twr-indeterminate", !!indeterminate);
            if (!indeterminate) fill.style.width = (pct || 0) + "%";
            txt.innerHTML = html;
        }

        _hideProgress() {
            this._el.querySelector("#twr-progress").classList.remove("twr-visible");
        }

        async onOpen() {
            if (!this.api.key) { this.render(); return; }
            if (this.wars === null) {
                this.setStatus("Loading your faction's wars…");
                try {
                    await this.svc.loadOurFaction();
                    this.wars = await this.svc.loadWars();
                    this.setStatus(`${this.wars.length} finished war(s) available for ${this.svc.ourFaction.name}.`);
                } catch (e) {
                    this.wars = [];
                    this._renderLoadError(e);
                    return;
                }
            }
            this.render();
        }

        _renderLoadError(e) {
            const body = this._el.querySelector("#twr-body");
            if (e.code === NO_ACCESS_ERROR_CODE) {
                body.innerHTML = `<div class="twr-empty">
                    <p><b>Your key can't read faction attack data.</b></p>
                    <p class="twr-sub">This report needs a key with <b>faction API access</b>
                    permission. Ask your faction leader to enable API access for your position,
                    or use a key from a member who has it.</p>
                </div>`;
            } else {
                body.innerHTML = `<div class="twr-empty">
                    <p>Failed to load: ${escapeHtml(e.message)}</p>
                </div>`;
            }
            this.setStatus("Error.");
        }

        render() {
            const body = this._el.querySelector("#twr-body");
            if (!this.api.key) return this._renderAuth(body);
            if (this.activeTab === "settings") return this._renderSettings(body);
            return this._renderReport(body);
        }

        _renderAuth(body) {
            body.innerHTML = `
                <div class="twr-auth">
                    <h3>Connect your Torn account</h3>
                    <p>Paste an API key with <b>faction API access</b> to build war reports.</p>
                    <input type="text" id="twr-key" maxlength="20" placeholder="16-character API key"
                           autocomplete="off" spellcheck="false">
                    <div class="twr-err" id="twr-key-err"></div>
                    <button class="twr-btn twr-primary" id="twr-key-save">Connect</button>
                    <div class="twr-note">
                        <b>Key level:</b> a <span class="twr-kk">Limited Access</span> key (or higher)
                        is required, <b>and</b> your faction position must have
                        <span class="twr-kk">API access</span> enabled — otherwise Torn refuses the
                        attack log (error 7). A minimal/public key is not enough.<br><br>
                        Get a key at <b>Settings → API</b> on torn.com. The key is stored only in this
                        browser and is sent only to <b>api.torn.com</b>. No backend, no telemetry.
                    </div>
                </div>`;
            const input = body.querySelector("#twr-key");
            const err = body.querySelector("#twr-key-err");
            const save = () => {
                try {
                    KeyResolver.save(input.value);
                    this.api.setKey(KeyResolver.resolve());
                    this.wars = null;
                    err.textContent = "";
                    this.onOpen();
                } catch (ex) { err.textContent = ex.message; }
            };
            body.querySelector("#twr-key-save").addEventListener("click", save);
            input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
        }

        _renderSettings(body) {
            const key = this.api.key;
            const masked = key ? key.slice(0, 4) + "…" + key.slice(-2) : "(none)";
            body.innerHTML = `
                <div class="twr-kv" style="margin-bottom:12px">
                    <p>API key: <b>${escapeHtml(masked)}</b></p>
                    <p class="twr-sub">Faction: <b>${escapeHtml(this.svc.ourFaction?.name || "—")}</b></p>
                </div>
                <button class="twr-btn" id="twr-key-change">Change key</button>
                <button class="twr-btn" id="twr-key-remove">Remove key</button>
                <div class="twr-note">
                    Only your faction's <b>finished</b> wars are listed. Ongoing wars are hidden
                    because they have no final report yet. Enemy attack logs aren't readable via the
                    API, so the enemy section is a totals-only summary.
                </div>`;
            body.querySelector("#twr-key-change").addEventListener("click", () => {
                KeyResolver.clear(); this.api.setKey(""); this.wars = null; this.render();
            });
            body.querySelector("#twr-key-remove").addEventListener("click", () => {
                KeyResolver.clear(); this.api.setKey(""); this.wars = null; this.result = null;
                this.setStatus("Key removed."); this.render();
            });
        }

        _renderReport(body) {
            const wars = this.wars || [];
            if (wars.length === 0) {
                body.innerHTML = `<div class="twr-empty">No finished ranked wars found for your faction.</div>`;
                return;
            }
            const opts = wars.map((w) => {
                const tag = w.outcome === "won" ? "W" : w.outcome === "lost" ? "L" : "D";
                const label = `vs ${w.enemyName} · ${fmt.date(w.start)} · ${tag}`;
                const sel = String(w.id) === String(this.selectedWarId) ? "selected" : "";
                return `<option value="${w.id}" ${sel}>${escapeHtml(label)}</option>`;
            }).join("");

            body.innerHTML = `
                <div class="twr-controls">
                    <select id="twr-war">${opts}</select>
                    <button class="twr-btn twr-primary" id="twr-gen" ${this.generating ? "disabled" : ""}>
                        ${this.generating ? "Fetching…" : "Generate report"}
                    </button>
                </div>
                <div class="twr-warn">
                    ⚠ Fetching a full war reads the whole attack log in pages of 100. It can take
                    <b>15–60+ seconds</b> and many API calls. Rate-limit pauses are handled
                    automatically — keep this panel open until it finishes.
                </div>
                <div id="twr-result"></div>`;

            const sel = body.querySelector("#twr-war");
            if (!this.selectedWarId && wars.length) this.selectedWarId = wars[0].id;
            sel.value = String(this.selectedWarId);
            sel.addEventListener("change", () => { this.selectedWarId = sel.value; });
            body.querySelector("#twr-gen").addEventListener("click", () => this.generate());

            if (this.result) this._renderResult(body.querySelector("#twr-result"));
            else if (this.genError) this._renderGenError(body.querySelector("#twr-result"));
        }

        _renderGenError(host) {
            if (this.genError === "access") {
                host.innerHTML = `<div class="twr-warn" style="color:#e0a0a0;background:#2a1616;border-color:#5a2020">
                    <b>Error 7 — your key can't read faction attacks.</b><br>
                    This report needs a <b>Limited Access</b> key (or higher) whose faction position
                    has <b>API access</b> enabled. A public/minimal key can list wars but can't read
                    the attack log. Ask your faction leader to enable API access for your position,
                    or paste a key that already has it in <b>Settings → Change key</b>.
                </div>`;
            } else {
                host.innerHTML = `<div class="twr-warn" style="color:#e0a0a0;background:#2a1616;border-color:#5a2020">
                    Failed to build the report: ${escapeHtml(this.genError)}
                </div>`;
            }
        }

        async generate() {
            if (this.generating) return;
            const war = (this.wars || []).find((w) => String(w.id) === String(this.selectedWarId));
            if (!war) return;
            this.generating = true;
            this.result = null;
            this.genError = null;
            this.render();
            const t0 = Date.now();
            try {
                this._showProgress("Fetching war summary…", 0, true);
                this.setStatus("Fetching war summary…");
                const report = await this.svc.loadReport(war.id);

                this._showProgress("Reading attack log…", 0, true);
                const attacks = await this.svc.loadAttacks(war.start, war.end, (page, total) => {
                    this._showProgress(
                        `Reading attack log — page <b>${page}</b>, <b>${fmt.num(total)}</b> attacks so far…`,
                        0, true);
                    this.setStatus(`Page ${page} · ${fmt.num(total)} attacks…`);
                });

                this.result = this.svc.aggregate(report, attacks, this.svc.ourFaction.id);
                this.result._attackCount = attacks.length;
                this.result._elapsed = Math.round((Date.now() - t0) / 1000);
                this.setStatus(`Done — ${fmt.num(attacks.length)} attacks in ${this.result._elapsed}s.`);
            } catch (e) {
                if (e.code === NO_ACCESS_ERROR_CODE) {
                    this.genError = "access";
                    this.setStatus("Key lacks faction API access (error 7).");
                } else {
                    this.genError = e.message;
                    this.setStatus(`Failed: ${e.message}`);
                }
            } finally {
                this.generating = false;
                this._hideProgress();
                this.render();
            }
        }

        _sortRows(rows) {
            const key = this.sortBy;
            const dir = this.sortDir === "asc" ? 1 : -1;
            const val = (r) => {
                switch (key) {
                    case "name": return r.name.toLowerCase();
                    case "war": return r.warHits;
                    case "outside": return r.outHits;
                    case "total": return r.warHits + r.outHits;
                    case "respect": return r.respect;
                    case "faced": return r.faced;
                    case "hitback": return r.hitBack;
                    case "defended": return r.defended;
                    default: return r.warHits + r.outHits;
                }
            };
            return [...rows].sort((a, b) => {
                const va = val(a), vb = val(b);
                if (va < vb) return -1 * dir;
                if (va > vb) return 1 * dir;
                return 0;
            });
        }

        _renderResult(host) {
            const r = this.result;
            const our = r.our, enemy = r.enemy;
            const won = r.winner == null ? "draw" : (r.winner === our.id ? "won" : "lost");
            const badge = won === "won" ? "WON" : won === "lost" ? "LOST" : "DRAW";

            const rows = this._sortRows(our.rows);
            const tot = our.rows.reduce((acc, x) => {
                acc.warHits += x.warHits; acc.outHits += x.outHits; acc.respect += x.respect;
                acc.faced += x.faced; acc.hitBack += x.hitBack; acc.defended += x.defended;
                return acc;
            }, { warHits: 0, outHits: 0, respect: 0, faced: 0, hitBack: 0, defended: 0 });

            const arrow = (k) => this.sortBy === k ? (this.sortDir === "asc" ? " ▲" : " ▼") : "";
            const th = (k, label, hint) =>
                `<th data-sort="${k}" title="${hint || ""}">${label}${arrow(k)}</th>`;

            const bodyRows = rows.map((x) => `
                <tr class="twr-row">
                    <td>${escapeHtml(x.name)} <span class="twr-sub">L${x.level || "?"}</span></td>
                    <td>${fmt.num(x.warHits)}</td>
                    <td>${fmt.num(x.outHits)}</td>
                    <td>${fmt.num(x.warHits + x.outHits)}</td>
                    <td>${fmt.respect(x.respect)}</td>
                    <td>${fmt.num(x.faced)}</td>
                    <td>${fmt.num(x.hitBack)}</td>
                    <td>${fmt.num(x.defended)}</td>
                </tr>`).join("");

            const enemyRows = [...enemy.rows]
                .sort((a, b) => (b.attacks || 0) - (a.attacks || 0))
                .map((m) => `
                    <tr class="twr-row">
                        <td>${escapeHtml(m.name)} <span class="twr-sub">L${m.level || "?"}</span></td>
                        <td>${fmt.num(m.attacks)}</td>
                        <td>${fmt.respect(m.score)}</td>
                    </tr>`).join("");

            host.innerHTML = `
                <div class="twr-outcome">
                    <span class="twr-badge ${won}">${badge}</span>
                    <span class="twr-score">${escapeHtml(our.name)} ${fmt.num(our.score)}
                        &ndash; ${fmt.num(enemy.score)} ${escapeHtml(enemy.name)}</span>
                    <span class="twr-sub">${fmt.dateTime(r.start)} → ${fmt.dateTime(r.end)}
                        · ${fmt.dur(r.end - r.start)}${r.forfeit ? " · forfeit" : ""}
                        · ${fmt.num(r._attackCount)} attacks read</span>
                </div>

                <div class="twr-sech">Your faction — per member</div>
                <table id="twr-our">
                    <thead><tr>
                        ${th("name", "Member")}
                        ${th("war", "War hits", "Successful ranked-war attacks")}
                        ${th("outside", "Outside hits", "Successful non-war attacks during the war window")}
                        ${th("total", "Total hits", "War + outside successful attacks")}
                        ${th("respect", "Respect", "Respect gained from successful attacks")}
                        ${th("faced", "Attacked", "Times this member was attacked by the enemy")}
                        ${th("hitback", "Hit", "Times the enemy successfully hit this member")}
                        ${th("defended", "Defended", "Times this member fought off the attacker")}
                    </tr></thead>
                    <tbody>${bodyRows}</tbody>
                    <tfoot><tr class="twr-total">
                        <td>Total (${our.rows.length})</td>
                        <td>${fmt.num(tot.warHits)}</td>
                        <td>${fmt.num(tot.outHits)}</td>
                        <td>${fmt.num(tot.warHits + tot.outHits)}</td>
                        <td>${fmt.respect(tot.respect)}</td>
                        <td>${fmt.num(tot.faced)}</td>
                        <td>${fmt.num(tot.hitBack)}</td>
                        <td>${fmt.num(tot.defended)}</td>
                    </tr></tfoot>
                </table>

                <div class="twr-sech">Enemy — ${escapeHtml(enemy.name)} (summary only)</div>
                <p class="twr-sub" style="margin:0 0 6px">
                    Enemy attack logs aren't readable via the API — only their official war
                    tally (attacks + score) is available.</p>
                <table id="twr-enemy">
                    <thead><tr>
                        <th class="twr-nosort">Member</th>
                        <th class="twr-nosort">War attacks</th>
                        <th class="twr-nosort">Score</th>
                    </tr></thead>
                    <tbody>${enemyRows}</tbody>
                </table>`;

            host.querySelectorAll("#twr-our th[data-sort]").forEach((thEl) => {
                thEl.addEventListener("click", () => {
                    const k = thEl.dataset.sort;
                    if (this.sortBy === k) this.sortDir = this.sortDir === "asc" ? "desc" : "asc";
                    else { this.sortBy = k; this.sortDir = k === "name" ? "asc" : "desc"; }
                    this._renderResult(host);
                });
            });
        }
    }

    // ════════════════════════════════════════════════════════════
    //  MAIN
    // ════════════════════════════════════════════════════════════

    const TWR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
        <defs><linearGradient id="twr_icon_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
        </linearGradient></defs>
        <g fill="url(#twr_icon_grad)">
            <path d="M6.9 3 3 6.9l8 8 1.5-1.5-.9-.9 2.2-2.2.9.9L16.2 9 8.2 1 6.9 3Zm-2 3.4L6.4 5l5.6 5.6-1.4 1.4L4.9 6.4Z"/>
            <path d="M17.1 3 21 6.9l-4.6 4.6-1.5-1.5.9-.9-2.2-2.2-.9.9L11.8 6l3.1-3 2.2 0Z"/>
            <path d="M3 17.1 6.9 21l1.4-1.4-.9-.9L9.6 16.5l.9.9L12 15.9 9.8 13.7 3 17.1Z"/>
            <path d="M15.7 13.7 21 17.1 17.1 21l-1.4-1.4.9-.9-2.2-2.2-.9.9-1.4-1.5 3.6-1.2Z"/>
        </g>
    </svg>`;

    async function main() {
        const api = new TornAPI(KeyResolver.resolve());
        const svc = new WarService(api);
        const ui = new UI(svc);
        ui.inject();

        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        W.registerEugeneScript({
            id: "twr",
            name: "Torn War Report",
            color: "#c0392b",
            colorDark: "#6e2018",
            hoverColor: "#e0574a",
            iconSVG: TWR_ICON_SVG,
            onClick: () => ui.toggle(true),
        });
        W.mountEugeneFooterMenu();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
