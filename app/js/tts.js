'use strict';

// TTS config pane + playback, internalized from LLM-Gateway-Chat's
// lib/tts/nspeech-controller.js pattern (two-select engine→voice, prefs,
// extra_body construction). Playback uses the vendored SpeechPlayer
// (MSE progressive playback, pause/resume independent of download).
//
// Scope decisions vs. the chat controller:
// - Local + cloud engines are listed (user explicitly asked for cloud,
//   same as the chat). Selecting a cloud engine and pressing Listen is
//   the user's explicit paid action.
// - Engine switching (POST /v1/admin/engine) is not offered — that's
//   dashboard territory.
// - Prefs live in localStorage (nmdv-tts-*).

import { SpeechPlayer } from './lib/nspeech-client.js';

const SENTINEL = 'nspeech'; // "whatever the dashboard selected"
const PREF = { engine: 'nmdv-tts-engine', voice: 'nmdv-tts-voice', speed: 'nmdv-tts-speed', clean: 'nmdv-tts-clean', stitch: 'nmdv-tts-stitch' };

export function createTts({ baseUrl, elements, onStatus, onState }) {
	const t = {
		available: false,
		engine: SENTINEL,
		voice: '',
		speed: 1.0,
		clean: true,
		stitch: false,
		engines: [],
		voicesByEngine: new Map(),
		currentEngine: null, // actual name behind the sentinel
		player: null
	};

	const el = elements;
	const pref = {
		get: (k) => localStorage.getItem(k),
		set: (k, v) => localStorage.setItem(k, v)
	};
	// Checkbox ids sit on the <input> itself — normalize to the input element
	const box = (e) => e.tagName === 'INPUT' ? e : e.querySelector('input');

	// ################################# INIT

	t.init = async () => {
		t.engine = pref.get(PREF.engine) || SENTINEL;
		t.voice = pref.get(PREF.voice) || '';
		t.speed = parseFloat(pref.get(PREF.speed)) || 1.0;
		t.clean = pref.get(PREF.clean) !== 'off'; // default on
		t.stitch = pref.get(PREF.stitch) === 'true';

		el.speed.querySelector('input').value = t.speed;
		box(el.clean).checked = t.clean;
		box(el.stitch).checked = t.stitch;

		t.player = new SpeechPlayer({ baseUrl });
		t.player.on('state', ({ state }) => onState?.(state));
		t.player.on('time', (time) => onState?.('time', time));
		t.player.on('error', ({ error }) => onStatus?.(`TTS playback error: ${error?.message || error}`));

		wireEvents();
		await t.loadEngines();
	};

	function wireEvents() {
		el.engine.addEventListener('nui-change', (e) => {
			t.engine = e.detail?.values?.[0] || SENTINEL;
			t.voice = '';
			pref.set(PREF.engine, t.engine);
			pref.set(PREF.voice, '');
			updateVoiceSelect();
			t._onSettingsChanged();
		});
		el.voice.addEventListener('nui-change', (e) => {
			t.voice = e.detail?.values?.[0] || '';
			pref.set(PREF.voice, t.voice);
			t._onSettingsChanged();
		});
		el.speed.querySelector('input').addEventListener('change', (e) => {
			t.speed = parseFloat(e.target.value) || 1.0;
			pref.set(PREF.speed, String(t.speed));
			t._onSettingsChanged();
		});
		el.clean && box(el.clean).addEventListener('change', (e) => {
			t.clean = e.target.checked;
			pref.set(PREF.clean, t.clean ? 'true' : 'off');
			t._onSettingsChanged();
		});
		el.stitch && box(el.stitch).addEventListener('change', (e) => {
			t.stitch = e.target.checked;
			pref.set(PREF.stitch, String(t.stitch));
			t._onSettingsChanged();
		});
	}

	// ################################# ENGINE / VOICE CATALOG

	t.loadEngines = async () => {
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 8000);
		try {
			const [engRes, voiceRes] = await Promise.all([
				fetch(`${baseUrl}/v1/admin/engines`, { signal: abort.signal }),
				fetch(`${baseUrl}/v1/voices`, { signal: abort.signal })
			]);
			if (!engRes.ok) throw new Error(`engines HTTP ${engRes.status}`);

			const engData = await engRes.json();
			t.engines = Array.isArray(engData.engines) ? engData.engines : [];
			t.currentEngine = engData.current || null;
			t.voicesByEngine = new Map([[SENTINEL, voiceRes.ok ? (await voiceRes.json()).voices || [] : []]]);

			// Resident local engines (gpu:false, venv present, not current) —
			// callable WITHOUT switching, like cloud providers but free + local.
			const residents = t.engines.filter(e => !e.type && !e.gpu && e.venv_exists && e.name !== t.currentEngine);
			// Cloud engines — fetched the same way (chat-controller pattern).
			const remoteEngines = [...residents, ...t.engines.filter(e => e.type === 'cloud')];
			const results = await Promise.all(remoteEngines.map(async (eng) => {
				try {
					const r = await fetch(`${baseUrl}/v1/voices?engine=${encodeURIComponent(eng.name)}`, { signal: abort.signal });
					return { name: eng.name, voices: r.ok ? (await r.json()).voices || [] : [] };
				} catch {
					return { name: eng.name, voices: [] };
				}
			}));
			for (const { name, voices } of results) t.voicesByEngine.set(name, voices);

			t.available = true;
			updateEngineSelect();
			updateVoiceSelect();
			setStatus(null);
		} catch (err) {
			t.available = false;
			t.engines = [];
			t.voicesByEngine.clear();
			setStatus(`TTS unavailable (${err.message})`);
		} finally {
			clearTimeout(timer);
		}
	};

	function updateEngineSelect() {
		const options = [];
		const display = t.currentEngine ? t.currentEngine.charAt(0).toUpperCase() + t.currentEngine.slice(1) : 'nSpeech';
		options.push({ value: SENTINEL, label: `Active (${display})` });

		const residents = t.engines
			.filter(e => !e.type && !e.gpu && e.venv_exists && e.name !== t.currentEngine)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const eng of residents) {
			options.push({ value: eng.name, label: eng.name.charAt(0).toUpperCase() + eng.name.slice(1) });
		}

		const clouds = t.engines
			.filter(e => e.type === 'cloud')
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const eng of clouds) {
			options.push({ value: eng.name, label: eng.name.charAt(0).toUpperCase() + eng.name.slice(1) });
		}

		el.engine.setItems(options);
		el.engine.setValue(options.some(o => o.value === t.engine) ? t.engine : SENTINEL);
	}

	function updateVoiceSelect() {
		const voices = t.voicesByEngine.get(t.engine) || [];
		if (!voices.length) {
			t.voice = '';
			el.voice.setItems([{ value: '', label: 'No voices available' }]);
			return;
		}
		const featured = (v) => v.voice_type === 'preset' || v.category === 'cloned';
		const sorted = [...voices].sort((a, b) => {
			const d = (featured(a) ? 0 : 1) - (featured(b) ? 0 : 1);
			return d || String(a.name || a.voice_id).localeCompare(String(b.name || b.voice_id));
		});
		const items = sorted.map(v => ({
			value: v.voice_id || v.name,
			label: (featured(v) ? '★ ' : '') + (v.name || v.voice_id)
		}));
		el.voice.setItems(items);
		// nSpeech engines require an explicit voice — there is no working
		// 'default' (zero-shot cloning engines 500 without a reference).
		// Mirror the chat controller: auto-select the first voice when the
		// stored one is missing or invalid for this engine.
		if (!items.some(i => i.value === t.voice)) {
			t.voice = items[0].value;
			pref.set(PREF.voice, t.voice);
		}
		el.voice.setValue(t.voice);
	}

	function setStatus(msg) {
		if (!el.status) return;
		el.status.textContent = msg || '';
		el.status.hidden = !msg;
	}

	// ################################# PLAYBACK

	// Toggle semantics: same document → pause/resume (or cancel while loading).
	t.speak = (text) => {
		if (!t.available) { onStatus?.('TTS unavailable'); return; }
		if (!t.voice) { onStatus?.('Select a voice first (engine has none)'); return; }
		t.player.toggle({
			model: t.engine,
			input: text,
			voice: t.voice,
			format: 'mp3',
			speed: t.speed,
			clean: t.clean,
			extraBody: { mode: t.stitch ? 'stitch' : 'stream' },
			context: 'document'
		});
	};

	t.stop = () => t.player?.stop();
	// A settings change invalidates the in-flight generation: stop the download
	// AND discard its buffered bytes (SpeechPlayer.stop clears _collected) so
	// the next speak() regenerates from the new settings. No-op when idle.
	// Shared by engine/voice/speed/clean/stitch. (ported from chat controller)
	t._onSettingsChanged = () => t.stop();
	t.isActive = () => t.player?.isActive?.() ?? false;

	return t;
}
