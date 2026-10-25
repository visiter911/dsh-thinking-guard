/**
 * dsh-thinking-guard — 客户端半边。
 *
 * 只做两件事：在 composer 底栏画一个「规则」胶囊，点开画一个面板壳。
 * 面板里的条目**全部**来自宿主下发的 `defs`，这里不写死任何规则 ——
 * 所以永远不会出现「界面显示开了、服务端判的是另一套」。
 *
 * 本版规则清单为空，面板显示空态；胶囊徽章显示 0。
 */
window.__ModuleLoader__.load({
	id: 'dsh-thinking-guard',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;
		const { useCallback, useEffect, useRef, useState } = React;

		const API = '/dsh-thinking-guard';
		const zh = (navigator.language || '').toLowerCase().startsWith('zh');

		const L = zh
			? {
				label: '规则',
				title: '本会话规则',
				empty: '暂无规则',
				applied: '已生效',
			emptyHint: '规则清单由宿主下发，这里只负责显示。',
				scope: '仅本会话',
				reset: '恢复默认',
				loading: '读取中…',
				offline: '读取失败',
				trigger: '本会话的插件规则',
			}
			: {
				label: 'Rules',
				title: 'Session rules',
				empty: 'No rules yet',
				applied: '已生效',
			emptyHint: 'The host owns the rule list; this panel only renders it.',
				scope: 'This session',
				reset: 'Reset',
				loading: 'Loading…',
				offline: 'Failed to load',
				trigger: 'Plugin rules for this session',
			};

		const ui = {
			trigger: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				height: 26,
				padding: '0 8px',
				borderRadius: 999,
				border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, rgba(229,229,229,.72))',
				font: 'inherit',
				fontSize: 12,
				lineHeight: 1,
				cursor: 'pointer',
				whiteSpace: 'nowrap',
			},
			triggerOn: {
				color: 'var(--dsw-alias-label-primary, #e5e5e5)',
				borderColor: 'var(--dsw-alias-border-primary, rgba(160,160,160,.55))',
			},
			badge: {
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				minWidth: 15,
				height: 15,
				padding: '0 4px',
				borderRadius: 999,
				fontSize: 10,
				background: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.3))',
				color: 'var(--dsw-alias-label-secondary, rgba(229,229,229,.8))',
			},
			panel: {
				position: 'fixed',
				zIndex: 60,
				width: 320,
				maxWidth: 'calc(100vw - 24px)',
				padding: 12,
				borderRadius: 12,
				border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.35))',
				background: 'var(--dsw-alias-bg-layer-2, #202124)',
				boxShadow: '0 12px 32px rgba(0,0,0,.45)',
				color: 'var(--dsw-alias-label-primary, #e5e5e5)',
				fontSize: 13,
			},
			header: {
				display: 'flex',
				alignItems: 'baseline',
				justifyContent: 'space-between',
				gap: 8,
				marginBottom: 10,
			},
			title: { fontWeight: 600 },
			scope: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.5))' },
			empty: {
				display: 'flex',
				flexDirection: 'column',
				gap: 4,
				padding: '14px 12px',
				borderRadius: 8,
				border: '1px dashed var(--dsw-alias-border-secondary, rgba(128,128,128,.3))',
				color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.55))',
			},
			emptyTitle: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, rgba(229,229,229,.72))' },
			emptyHint: { fontSize: 11, lineHeight: 1.5 },
			footer: {
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: 8,
				marginTop: 10,
				paddingTop: 10,
				borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
			},
			note: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.5))' },
			link: {
				border: 'none',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary, rgba(229,229,229,.72))',
				font: 'inherit',
				fontSize: 11,
				cursor: 'pointer',
				padding: 0,
				textDecoration: 'underline',
			},
			expander: {
				margin: 0,
				padding: '0 0 0 6px',
				border: 'none',
				background: 'transparent',
				color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.6))',
				font: 'inherit',
				fontSize: 11,
				lineHeight: 1,
				cursor: 'pointer',
			},
			error: { margin: '8px 0 0', fontSize: 11, color: 'var(--dsw-alias-label-danger, #f87171)' },
		};

		function SlidersIcon() {
			return h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', 'aria-hidden': true, style: { display: 'block' } },
				h('path', {
					d: 'M2 4h7M12 4h2M2 8h3M8 8h6M2 12h8M13 12h1',
					stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none',
				}),
				h('circle', { cx: 10.5, cy: 4, r: 1.5, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
				h('circle', { cx: 6.5, cy: 8, r: 1.5, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
				h('circle', { cx: 11.5, cy: 12, r: 1.5, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
			);
		}

		async function getState(sessionId) {
			const response = await fetch(`${API}/state?sessionId=${encodeURIComponent(sessionId)}`, {
				headers: { accept: 'application/json' },
			});
			const data = await response.json().catch(() => undefined);
			if (data === undefined || data.ok !== true) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data;
		}

		async function putRules(sessionId, rules) {
			const response = await fetch(`${API}/rules`, {
				method: 'PUT',
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify({ sessionId, rules }),
			});
			const data = await response.json().catch(() => undefined);
			if (data === undefined || data.ok !== true) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data;
		}

		function Switch(props) {
			const { checked, disabled, onToggle, label } = props;
			return h('button', {
				type: 'button',
				role: 'switch',
				'aria-checked': checked,
				'aria-label': label,
				disabled,
				onClick: onToggle,
				style: {
					position: 'relative',
					flex: 'none',
					width: 36,
					height: 20,
					padding: 0,
					borderRadius: 999,
					border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.45))',
					background: checked
						? 'var(--dsw-alias-bg-accent, #4c8dff)'
						: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.28))',
					cursor: disabled ? 'not-allowed' : 'pointer',
					opacity: disabled ? 0.5 : 1,
					transition: 'background .15s ease',
				},
			}, h('span', {
				style: {
					position: 'absolute',
					top: 2,
					left: checked ? 18 : 2,
					width: 14,
					height: 14,
					borderRadius: '50%',
					background: '#fff',
					boxShadow: '0 1px 3px rgba(0,0,0,.35)',
					transition: 'left .15s ease',
				},
			}));
		}

		async function getProvider(providerId) {
			const response = await fetch(`${API}/provider?providerId=${encodeURIComponent(providerId)}`, {
				headers: { accept: 'application/json' },
			});
			const data = await response.json().catch(() => undefined);
			if (data === undefined || data.ok !== true) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data;
		}

		async function putProvider(providerId, replayThinking) {
			const response = await fetch(`${API}/provider`, {
				method: 'PUT',
				headers: { accept: 'application/json', 'content-type': 'application/json' },
				body: JSON.stringify({ providerId, replayThinking }),
			});
			const data = await response.json().catch(() => undefined);
			if (data === undefined || data.ok !== true) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data;
		}

		/**
		 * 设置 → 模型 → 供应商卡片里的「思考块回传」开关。
		 *
		 * 挂在 settings.models.provider-card：该插槽渲染在卡片内、表单之上。
		 * 官方供应商缺省打开：服务端要求多轮工具调用带 reasoning_content。
		 */
		function ProviderReplayRow(props) {
			const entry = props && props.provider;
			const providerId = entry === undefined || entry === null
				? ''
				: String(entry.provider || entry.id || '');
			const [state, setState] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState('');

			const load = useCallback(() => {
				if (providerId === '') return;
				setError('');
				getProvider(providerId)
					.then(setState)
					.catch((failure) => setError(String((failure && failure.message) || failure)));
			}, [providerId]);

			useEffect(() => { load(); }, [load]);

			const toggle = useCallback(() => {
				if (providerId === '' || state === null) return;
				setBusy(true);
				setError('');
				putProvider(providerId, state.replayThinking !== true)
					.then(setState)
					.catch((failure) => setError(String((failure && failure.message) || failure)))
					.finally(() => setBusy(false));
			}, [providerId, state]);

			if (providerId === '') return null;

			const on = state !== null && state.replayThinking === true;
			return h('div', {
				style: {
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: 12,
					margin: '4px 0 10px',
					padding: '8px 10px',
					borderRadius: 8,
					border: '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.25))',
					background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06))',
				},
			}, [
				h('div', { key: 'txt', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
					h('span', { key: 'l', style: { fontSize: 13 } }, zh ? '思考块回传' : 'Replay thinking blocks'),
					h('span', {
						key: 'h',
						style: { fontSize: 11, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.55))' },
					}, zh
						? (state !== null && state.official
							? '官方供应商缺省打开：多轮工具调用需要 reasoning_content'
							: '非官方供应商缺省关闭')
						: (state !== null && state.official
							? 'On by default for official providers: multi-turn tool calls need reasoning_content'
							: 'Off by default for third-party providers')),
					error !== '' ? h('span', { key: 'e', style: { fontSize: 11, color: 'var(--dsw-alias-label-danger, #f87171)' } }, error) : null,
				]),
				h(Switch, { key: 'sw', checked: on, disabled: busy || state === null, label: zh ? '思考块回传' : 'Replay thinking blocks', onToggle: toggle }),
			]);
		}

		/**
		 * composer 底栏的「规则」胶囊。
		 *
		 * 挂在 conversation.input.left —— 该插槽渲染在权限胶囊之后，
		 * 正好是"完全权限"右边。
		 */
		function RuleMenu(props) {
			const sessionId = props && props.sessionId;
			const [open, setOpen] = useState(false);
			const [state, setState] = useState(null);
			const [error, setError] = useState('');
			const [pos, setPos] = useState(null);
			const [expanded, setExpanded] = useState({});
			const [busy, setBusy] = useState(false);
			const triggerRef = useRef(null);

			const load = useCallback(() => {
				if (typeof sessionId !== 'string' || sessionId === '') return;
				setError('');
				getState(sessionId)
					.then(setState)
					.catch((failure) => setError(String((failure && failure.message) || failure)));
			}, [sessionId]);

			const toggleRule = useCallback((key, value) => {
				if (typeof sessionId !== 'string' || sessionId === '') return;
				setBusy(true);
				setError('');
				putRules(sessionId, { [key]: value })
					.then(setState)
					.catch((failure) => setError(String((failure && failure.message) || failure)))
					.finally(() => setBusy(false));
			}, [sessionId]);

			useEffect(() => { load(); }, [load]);

			// 点外部 / Esc 关闭
			useEffect(() => {
				if (!open) return undefined;
				const onDown = (event) => {
					const panel = document.getElementById('thinking-guard-panel');
					const trigger = triggerRef.current;
					if (panel && panel.contains(event.target)) return;
					if (trigger && trigger.contains(event.target)) return;
					setOpen(false);
				};
				const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
				document.addEventListener('mousedown', onDown, true);
				document.addEventListener('keydown', onKey);
				return () => {
					document.removeEventListener('mousedown', onDown, true);
					document.removeEventListener('keydown', onKey);
				};
			}, [open]);

			const toggleOpen = useCallback(() => {
				if (!open && triggerRef.current) {
					const rect = triggerRef.current.getBoundingClientRect();
					const width = 320;
					const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
					// composer 在底部，面板向上弹
					const bottom = Math.max(8, window.innerHeight - rect.top + 8);
					setPos({ left, bottom });
					load();
				}
				setOpen((value) => !value);
			}, [open, load]);

			// 没有会话 id 时不显示（新会话建立前）
			if (typeof sessionId !== 'string' || sessionId === '') return null;

			const defs = state && Array.isArray(state.defs) ? state.defs : [];
			const topCount = defs.filter((d) => d.parent === undefined).length;
			const count = state && typeof state.enabledCount === 'number' ? state.enabledCount : 0;
			const overridden = state && state.overridden === true;

			const trigger = h('button', {
				ref: triggerRef,
				type: 'button',
				'aria-haspopup': 'dialog',
				'aria-expanded': open,
				title: L.trigger,
				onClick: toggleOpen,
				style: { ...ui.trigger, ...(overridden ? ui.triggerOn : null) },
			}, [
				h(SlidersIcon, { key: 'i' }),
				h('span', { key: 't' }, L.label),
				h('span', { key: 'b', style: ui.badge }, String(count)),
			]);

			if (!open) return trigger;

			const panel = h('div', {
				id: 'thinking-guard-panel',
				role: 'dialog',
				'aria-label': L.title,
				style: { ...ui.panel, ...(pos || {}) },
			}, [
				h('div', { key: 'h', style: ui.header }, [
					h('span', { key: 't', style: ui.title }, L.title),
					h('span', { key: 's', style: ui.scope }, `${L.scope} · ${sessionId.slice(0, 8)}`),
				]),
				defs.length === 0
					? h('div', { key: 'empty', style: ui.empty }, [
							h('span', { key: 't', style: ui.emptyTitle }, L.empty),
							h('span', { key: 'h', style: ui.emptyHint }, L.emptyHint),
						])
					: h('div', { key: 'list' }, (() => {
							const topLevel = defs.filter((d) => d.parent === undefined);
							const childrenOf = (key) => defs.filter((d) => d.parent === key);
							const renderRow = (def, nested, parentOff) => {
								const on = state !== null && state.rules && state.rules[def.key] === true;
								const kids = childrenOf(def.key);
								const disabled = busy || parentOff;
								return h('div', {
									key: def.key,
									style: {
										display: 'flex',
										alignItems: 'flex-start',
										justifyContent: 'space-between',
										gap: 10,
										padding: nested ? '6px 0 6px 10px' : '7px 0',
										marginLeft: nested ? 10 : 0,
										borderLeft: nested
											? '1px solid var(--dsw-alias-border-secondary, rgba(128,128,128,.28))'
											: 'none',
									},
								}, [
									h('div', { key: 'txt', style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } }, [
										h('span', { key: 'l', style: { fontSize: nested ? 12.5 : 13 } }, [
											zh ? def.zh : def.en,
											kids.length > 0
												? h('button', {
														key: 'x',
														type: 'button',
														'aria-expanded': expanded[def.key] === true,
														title: zh ? '展开子项' : 'Show sub-options',
														onClick: () => setExpanded((prev) => ({ ...prev, [def.key]: !prev[def.key] })),
														style: ui.expander,
													}, expanded[def.key] === true ? '▾' : '▸')
												: null,
										]),
										h('span', { key: 'h', style: { fontSize: 11, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary, rgba(229,229,229,.55))' } },
											zh ? def.zhHint : def.enHint),
									]),
									h(Switch, {
										key: 'sw',
										checked: on,
										disabled,
										label: zh ? def.zh : def.en,
										onToggle: () => toggleRule(def.key, !on),
									}),
								]);
							};
							const rows = [];
							for (const def of topLevel) {
								const parentOn = state !== null && state.rules && state.rules[def.key] === true;
								rows.push(renderRow(def, false, false));
								const kids = childrenOf(def.key);
								if (kids.length > 0 && expanded[def.key] === true) {
									for (const kid of kids) rows.push(renderRow(kid, true, parentOn !== true));
								}
							}
							return rows;
						})()),
				h('div', { key: 'f', style: ui.footer }, [
					h('span', { key: 'n', style: ui.note }, state === null ? L.loading : `${count} / ${topCount}`),
					state !== null && state.applied != null
						? h('span', { key: 'ap', style: ui.note },
							`${new Date(state.applied.at).toLocaleTimeString()} ${L.applied}`)
						: null,
				]),
				error !== '' ? h('p', { key: 'e', style: ui.error }, `${L.offline}: ${error}`) : null,
			]);

			return h(React.Fragment, null, trigger, panel);
		}

		const inject = ['slots'];

		function apply(ctx) {
			ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
				name: 'conversation.input.left',
				id: 'dsh-thinking-guard-rules',
				order: 10,
				inject: (sessionId) => ({ sessionId }),
			}, RuleMenu));

			// 设置 → 模型 → 供应商卡片。
			// 该插槽是 keyed：key 必须等于供应商的 settingsNs，否则不渲染。
			// 已知命名空间：llm-pi-ai（自定义供应商）、llm-deepseek（官方）。
			for (const key of ['llm-pi-ai', 'llm-deepseek']) {
				ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
					name: 'settings.models.provider-card',
					id: `dsh-thinking-guard-provider-replay-${key}`,
					key,
					order: 50,
				}, ProviderReplayRow));
			}
		}

		exports.name = 'thinking-guard';
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});



