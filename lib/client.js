window.__ModuleLoader__.load({
	id: "dsh-safety",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (e) { primitives = null; }
		const Button = primitives !== null ? primitives.Button : null;
		//#region dsh-safety client
		const NS = "dshSafety";
		const zh = {
			nav: "安全中心",
			title: "dsh-safety 安全中心",
			intro: "保护 DSH 配置与插件文件，删除进回收站、可快照回滚、重启前可校验。",
			status: "状态",
			guardBlocks: "已拦截操作",
			trashCount: "回收站",
			snapshotCount: "快照",
			lastCheck: "上次校验",
			notRun: "未运行",
			pass: "通过",
			fail: "未通过",
			check: "运行校验",
			checking: "校验中…",
			snapshot: "创建快照",
			snapshoting: "创建中…",
			snapshotLabel: "本次快照",
			trash: "回收站",
			restore: "恢复",
			restoring: "恢复中…",
			snapshots: "快照",
			restoreSnapshot: "回滚到该快照",
			confirmRestore: "确认回滚？将覆盖当前组合文件，当前版本会先备份。",
			confirm: "确认回滚",
			cancel: "取消",
			journal: "审计日志",
			empty: "暂无",
			err: "操作失败",
			ok: "成功",
		};
		const en = {
			nav: "Safety Center",
			title: "dsh-safety center",
			intro: "Protects DSH config & plugin files; deletes go to trash; snapshots enable rollback; pre-restart checks.",
			status: "Status",
			guardBlocks: "Blocked calls",
			trashCount: "Trash",
			snapshotCount: "Snapshots",
			lastCheck: "Last check",
			notRun: "not run",
			pass: "PASS",
			fail: "FAIL",
			check: "Run check",
			checking: "Checking…",
			snapshot: "Create snapshot",
			snapshoting: "Creating…",
			snapshotLabel: "snapshot",
			trash: "Trash",
			restore: "Restore",
			restoring: "Restoring…",
			snapshots: "Snapshots",
			restoreSnapshot: "Roll back to this snapshot",
			confirmRestore: "Confirm rollback? Live composition files will be overwritten (current versions backed up first).",
			confirm: "Roll back",
			cancel: "Cancel",
			journal: "Audit journal",
			empty: "empty",
			err: "Operation failed",
			ok: "OK",
		};
		const CSS = [
			".ds-root{box-sizing:border-box;width:100%;max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;padding:0 2px 24px;display:flex}",
			".ds-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}",
			".ds-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:13px;line-height:20px}",
			".ds-grid{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;display:grid}",
			".ds-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px}",
			".ds-k{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".ds-v{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:22px}",
			".ds-ok{color:var(--dsw-alias-state-success-primary)}",
			".ds-err{color:var(--dsw-alias-state-error-primary)}",
			".ds-toolbar{align-items:center;gap:8px;display:flex}",
			".ds-status{margin:0;font-size:12px;line-height:18px}",
			".ds-list{flex-direction:column;gap:6px;margin:6px 0 0;padding:0;list-style:none;display:flex}",
			".ds-row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;align-items:center;gap:8px;padding:8px 10px;display:flex}",
			".ds-row-main{flex:1;min-width:0;font-size:12px;line-height:18px;word-break:break-all}",
			".ds-pre{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-family:ui-monospace,Consolas,monospace}",
		].join("");
		const tagId = "dsh-safety/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-safety";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		const inject = ["locale", "slots"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-safety: dictionaries");
			const t = ctx.locale.bind(NS);
			function Section(props) {
				const [tick, setTick] = react.useState(0);
				react.useEffect(() => ctx.locale.subscribe(() => setTick((v) => v + 1)), []);
				const [state, setState] = react.useState(null);
				const [busy, setBusy] = react.useState({});
				const [status, setStatus] = react.useState(null);
				const [confirmId, setConfirmId] = react.useState(null);
				const show = (kind, text) => {
					setStatus({ kind, text });
					setTimeout(() => setStatus((s) => (s !== null && s.kind === kind ? null : s)), 3500);
				};
				const rpc = async (op, body) => {
					const res = await fetch("/safety/api", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(Object.assign({ op }, body || {}))
					});
					if (!res.ok) throw new Error("http-" + res.status);
					return res.json();
				};
				const load = async () => {
					try {
						const res = await fetch("/safety/api", { method: "GET" });
						if (!res.ok) throw new Error("http-" + res.status);
						setState(await res.json());
					} catch (e) {
						show("err", t("err") + " (" + e.message + ")");
					}
				};
				react.useEffect(() => { load(); }, []);
				const runCheck = async () => {
					setBusy((b) => Object.assign({}, b, { check: true }));
					try {
						const r = await rpc("check", {});
						setState((s) => Object.assign({}, s, { lastCheck: { pass: r.pass } }));
						show(r.pass ? "ok" : "err", r.pass ? t("pass") : t("fail"));
					} catch (e) { show("err", t("err")); }
					finally { setBusy((b) => Object.assign({}, b, { check: false })); }
				};
				const doSnapshot = async () => {
					setBusy((b) => Object.assign({}, b, { snapshot: true }));
					try {
						await rpc("snapshot", { label: t("snapshotLabel") });
						await load();
						show("ok", t("ok"));
					} catch (e) { show("err", t("err")); }
					finally { setBusy((b) => Object.assign({}, b, { snapshot: false })); }
				};
				const undo = async (id) => {
					setBusy((b) => Object.assign({}, b, { undo: id }));
					try {
						await rpc("undo", { id });
						await load();
						show("ok", t("ok"));
					} catch (e) { show("err", t("err")); }
					finally { setBusy((b) => Object.assign({}, b, { undo: null })); }
				};
				const rollback = async (id) => {
					setBusy((b) => Object.assign({}, b, { rollback: id }));
					try {
						await rpc("restore", { id, confirm: true });
						await load();
						show("ok", t("ok"));
					} catch (e) { show("err", t("err")); }
					finally { setBusy((b) => Object.assign({}, b, { rollback: null })); }
				};
				const lastCheck = state !== null && state.lastCheck !== null && state.lastCheck !== undefined
					? (state.lastCheck.pass ? react.createElement("span", { className: "ds-ok" }, t("pass")) : react.createElement("span", { className: "ds-err" }, t("fail")))
					: t("notRun");
				const card = (label, value) => react.createElement("div", { className: "ds-card" },
					react.createElement("div", { className: "ds-k" }, label),
					react.createElement("div", { className: "ds-v" }, value)
				);
				const btn = (label, onClick, disabled, keyLabel) => Button !== null
					? react.createElement(Button, { variant: "outline", size: "sm", disabled: disabled || false, onClick: onClick }, label)
					: react.createElement("button", { type: "button", disabled: disabled || false, onClick: onClick }, label);
				return react.createElement("div", { className: "ds-root" },
					react.createElement("h3", { className: "ds-title" }, t("title")),
					react.createElement("p", { className: "ds-intro" }, t("intro")),
					status !== null && react.createElement("p", { className: "ds-status " + (status.kind === "ok" ? "ds-ok" : "ds-err"), role: "status" }, status.text),
					react.createElement("div", { className: "ds-grid" },
						card(t("guardBlocks"), state !== null ? String(state.guardBlocks || 0) : "…"),
						card(t("trashCount"), state !== null ? String((state.trash || []).length) : "…"),
						card(t("snapshotCount"), state !== null ? String((state.snapshots || []).length) : "…"),
						card(t("lastCheck"), lastCheck)
					),
					react.createElement("div", { className: "ds-toolbar" },
						btn(t("check"), runCheck, busy.check === true || state === null, "check"),
						btn(t("snapshot"), doSnapshot, busy.snapshot === true || state === null, "snapshot")
					),
					react.createElement("div", { className: "ds-k" }, t("trash") + " (" + (state !== null ? (state.trash || []).length : 0) + ")"),
					react.createElement("ul", { className: "ds-list" },
						(state !== null && (state.trash || []).length > 0
							? state.trash.slice(0, 30)
							: []
						).map((e) => react.createElement("li", { className: "ds-row", key: e.id },
							react.createElement("div", { className: "ds-row-main" }, e.id + (e.isDir ? " [dir]" : "")),
							btn(t("restore"), () => undo(e.id), busy.undo === e.id, "undo-" + e.id)
						))
					),
					(state === null || (state.trash || []).length === 0) && react.createElement("p", { className: "ds-intro" }, t("empty")),
					react.createElement("div", { className: "ds-k" }, t("snapshots") + " (" + (state !== null ? (state.snapshots || []).length : 0) + ")"),
					react.createElement("ul", { className: "ds-list" },
						(state !== null ? (state.snapshots || []).slice(0, 30) : []).map((s) => react.createElement("li", { className: "ds-row", key: s.id },
							react.createElement("div", { className: "ds-row-main" }, s.id + " · " + s.files + " files"),
							react.createElement("button", {
								type: "button",
								disabled: busy.rollback === s.id,
								onClick: () => {
									if (confirmId === s.id) { setConfirmId(null); rollback(s.id); }
									else setConfirmId(s.id);
								}
							}, confirmId === s.id ? t("confirm") : t("restoreSnapshot"))
						))
					),
					(state === null || (state.snapshots || []).length === 0) && react.createElement("p", { className: "ds-intro" }, t("empty")),
					react.createElement("div", { className: "ds-k" }, t("journal")),
					react.createElement("pre", { className: "ds-pre" },
						state !== null && (state.journal || []).length > 0
							? state.journal.map((e) => "[" + (e.at || "?").slice(0, 19) + "] " + (e.kind || "?") + (e.original ? " " + e.original : "")).join("\n")
							: t("empty")
					)
				);
			}
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-safety", order: 60, label: () => t("nav") },
				(props) => react.createElement(Section, {})
			));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
