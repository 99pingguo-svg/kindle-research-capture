// Full-screen capture mode. Used both from the list's 📷 button (one product) and as
// 撮影モード over the current filtered list: shoot → shoot → 撮影完了 → next product.
import { h, clear, toast, showError, choose, sheet } from './ui.js';
import { api } from './api.js';
import { state, setPref, on, applyProduct, emit } from './state.js';
import { captureFrame, makeVariants } from './images.js';
import { fmtDay } from './calendar.js';
import * as uploads from './uploads.js';

let open = null;

export function openCamera({ ids, index = 0, tag = '', requestId = null }) {
  if (open) open.close();
  open = new CameraSession(ids, index, { tag, requestId });
}

class CameraSession {
  constructor(ids, index, { tag, requestId }) {
    this.ids = [...ids];
    this.i = Math.max(0, Math.min(index, this.ids.length - 1));
    this.tag = tag;
    this.requestId = requestId;
    this.full = new Map();
    this.chain = Promise.resolve();
    this.shotCount = 0;
    this.unsubs = [];
    this.build();
    this.start();
  }

  get id() {
    return this.ids[this.i];
  }

  build() {
    this.video = h('video', { playsinline: true, muted: true, autoplay: true });
    this.flash = h('div', { class: 'flash' });
    this.countEl = h('div', { class: 'count' });
    this.tagEl = h('div', { class: 'tagnow', style: { display: 'none' } });
    this.nocam = h('div', { class: 'nocam', style: { display: 'none' } });
    this.view = h('div', { class: 'cam-view' }, this.video, this.nocam, this.flash, this.countEl, this.tagEl);
    this.top = h('div', { class: 'cam-top' });
    this.info = h('div', { class: 'cam-info' });
    this.tags = h('div', { class: 'cam-tags' });
    this.strip = h('div', { class: 'cam-strip' });
    this.fileCapture = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' }, onchange: (e) => this.addFiles(e.target.files, 'camera') });
    this.fileLibrary = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: (e) => this.addFiles(e.target.files, 'library') });

    this.shutter = h('button', { class: 'shutter', 'aria-label': '撮影' });
    this.bindShutter();
    this.prevBtn = h('button', { class: 'cam-btn', onclick: () => this.go(-1) }, '← 前');
    this.nextBtn = h('button', { class: 'cam-btn', onclick: () => this.go(1) }, '次 →');
    const controls = h('div', { class: 'cam-controls' }, h('div', { class: 'left' }, this.prevBtn), this.shutter, h('div', { class: 'right' }, this.nextBtn));
    this.doneBtn = h('button', { class: 'cam-btn done', onclick: () => this.done() }, '撮影完了 ✓');
    const bottom = h('div', { class: 'cam-bottom' },
      h('button', { class: 'cam-btn', style: { flex: '0 0 auto' }, onclick: () => this.fileLibrary.click() }, '🖼 追加'),
      this.doneBtn,
      h('button', { class: 'cam-btn', style: { flex: '0 0 auto' }, onclick: () => this.newProduct() }, '＋新商品'));

    this.root = h('div', { class: 'camera', role: 'dialog', 'aria-label': '撮影モード' },
      h('div', null, this.top, this.info), this.tags, this.view, this.strip, h('div', null, controls, bottom), this.fileCapture, this.fileLibrary);
    document.getElementById('overlay-root').append(this.root);

    this.onKey = (e) => {
      if (e.target.closest?.('input,textarea,select')) return;
      if (e.key === ' ') { e.preventDefault(); this.shoot(); }
      else if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'Enter') this.done();
      else if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.onKey);
    this.unsubs.push(on('uploads', () => this.renderStrip()));
    this.unsubs.push(on('uploaded', (ev) => {
      if (ev.summary) state.products.set(ev.productId, ev.summary);
      if (ev.productId === this.id) this.loadFull(this.id, true);
    }));
  }

  bindShutter() {
    let burstTimer = null;
    let burstInterval = null;
    let bursting = false;
    const stop = () => {
      clearTimeout(burstTimer);
      clearInterval(burstInterval);
      this.shutter.classList.remove('burst');
    };
    this.shutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bursting = false;
      if (!this.stream) return;
      burstTimer = setTimeout(() => {
        bursting = true;
        this.shutter.classList.add('burst');
        this.shoot();
        burstInterval = setInterval(() => this.shoot(), 650);
      }, 450);
    });
    this.shutter.addEventListener('pointerup', (e) => {
      e.preventDefault();
      stop();
      if (!bursting) this.shoot();
    });
    this.shutter.addEventListener('pointercancel', stop);
    this.shutter.addEventListener('pointerleave', stop);
    this.shutter.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  async start() {
    this.render();
    this.requestWakeLock();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.showNoCam('この接続ではアプリ内カメラが使えません（HTTPS が必要）。\nシャッターを押すと標準カメラが起動します。');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } },
        audio: false,
      });
      if (!this.root.isConnected) return this.stopStream();
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => {});
    } catch (e) {
      this.showNoCam(`カメラを起動できません（${e.name || e.message}）。\nシャッターを押すと標準カメラが起動します。`);
    }
  }

  showNoCam(msg) {
    this.video.style.display = 'none';
    this.nocam.style.display = 'block';
    this.nocam.textContent = msg;
  }

  async requestWakeLock() {
    try {
      this.wake = await navigator.wakeLock?.request('screen');
    } catch {
      /* not supported */
    }
  }

  stopStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  close() {
    this.stopStream();
    this.wake?.release?.().catch(() => {});
    document.removeEventListener('keydown', this.onKey);
    this.unsubs.forEach((u) => u());
    this.root.remove();
    open = null;
    emit('list');
  }

  async loadFull(id, force = false) {
    if (!id) return;
    if (this.full.has(id) && !force) return this.full.get(id);
    try {
      const p = await api.get(`/api/products/${id}`);
      this.full.set(id, p);
      if (p.summary) state.products.set(id, p.summary);
      if (id === this.id) this.render();
      return p;
    } catch (e) {
      if (e.status === 404) toast(`商品 ${id} が見つかりません`, { error: true });
    }
  }

  render() {
    const sm = state.products.get(this.id) || {};
    const full = this.full.get(this.id);
    if (!full) this.loadFull(this.id);
    if (this.ids[this.i + 1]) this.loadFull(this.ids[this.i + 1]);

    clear(this.top).append(
      h('button', { class: 'cam-btn', onclick: () => this.close(), 'aria-label': '閉じる' }, '✕'),
      h('div', { class: 'counter' }, this.ids.length > 1 ? `商品 ${this.i + 1} / ${this.ids.length}` : '撮影'),
      h('button', { class: 'cam-btn', onclick: () => this.settings(), 'aria-label': '設定' }, '⚙'));

    clear(this.info).append(
      h('div', { class: 'ref', style: { backgroundImage: sm.thumb ? `url("${sm.thumb}")` : '' } }),
      h('div', { style: { minWidth: 0 } },
        h('div', { class: 'nm' }, h('span', { style: { opacity: '.6', fontSize: '14px', marginRight: '6px' } }, this.id), sm.name || '名称未設定（AIが写真から特定）'),
        h('div', { class: 'sub' }, [sm.itemDate && `📅 ${fmtDay(sm.itemDate)}`, sm.brand, sm.model].filter(Boolean).join(' · ') || ' ')));

    const reqs = full ? full.photoRequests.filter((r) => !r.doneAt && !r.cancelledAt) : sm.openPhotoRequests || [];
    clear(this.tags).append(
      ...reqs.map((r) => h('button', { class: `cam-btn req ${this.requestId === r.id ? 'on' : ''}`, onclick: () => this.setTag(r.label, r.id) }, `📷 ${r.label}`)),
      ...state.meta.photoTags.map((t) => h('button', { class: `cam-btn ${this.tag === t && !this.requestId ? 'on' : ''}`, onclick: () => this.setTag(t, null) }, t)));

    this.prevBtn.disabled = this.i === 0;
    this.nextBtn.disabled = this.i >= this.ids.length - 1;
    this.prevBtn.style.opacity = this.i === 0 ? '.35' : '';
    this.nextBtn.style.opacity = this.i >= this.ids.length - 1 ? '.35' : '';
    this.tagEl.style.display = this.tag ? '' : 'none';
    this.tagEl.textContent = this.tag ? `次の写真: ${this.tag}` : '';
    this.renderStrip();
  }

  renderStrip() {
    if (!this.root.isConnected) return;
    const full = this.full.get(this.id);
    const server = full ? full.photos.filter((p) => !p.deletedAt && p.kind === 'actual').reverse() : [];
    const pending = uploads.pendingFor(this.id).filter((p) => p.kind === 'actual');
    clear(this.strip).append(
      ...pending.reverse().map((p) => h('img', { src: p.url, class: 'pending', title: p.error || 'アップロード中', onclick: () => this.pendingMenu(p) })),
      ...server.map((ph) => h('img', { src: `/files/products/${this.id}/${ph.files.thumb}`, onclick: () => this.photoMenu(ph) })));
    const n = server.length + pending.length;
    this.countEl.textContent = `${n}枚`;
  }

  setTag(tag, requestId) {
    if (this.tag === tag && this.requestId === requestId) {
      this.tag = '';
      this.requestId = null;
    } else {
      this.tag = tag;
      this.requestId = requestId;
    }
    this.render();
  }

  afterShot() {
    this.shotCount++;
    if (!state.prefs.camKeepTag && (this.tag || this.requestId)) {
      this.tag = '';
      this.requestId = null;
      this.render();
    }
  }

  shoot() {
    if (!this.stream || !this.video.videoWidth) {
      this.fileCapture.value = '';
      this.fileCapture.click();
      return;
    }
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
    const productId = this.id;
    const meta = { productId, kind: 'actual', source: 'camera', tag: this.tag, requestId: this.requestId, takenAt: new Date().toISOString() };
    // Grab the frame immediately; encode sequentially so photo order is preserved.
    const c = document.createElement('canvas');
    c.width = this.video.videoWidth;
    c.height = this.video.videoHeight;
    c.getContext('2d').drawImage(this.video, 0, 0);
    this.afterShot();
    this.chain = this.chain
      .then(async () => {
        const v = await captureFrame(c);
        await uploads.enqueue({ ...meta, ...v });
      })
      .catch(showError);
  }

  async addFiles(fileList, source) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    const productId = this.id;
    const meta = { productId, kind: 'actual', source, tag: this.tag, requestId: this.requestId };
    this.afterShot();
    for (const f of files) {
      this.chain = this.chain
        .then(async () => {
          const v = await makeVariants(f);
          await uploads.enqueue({ ...meta, original: f, work: v.work, thumb: v.thumb, width: v.width, height: v.height, takenAt: new Date(f.lastModified || Date.now()).toISOString() });
        })
        .catch(showError);
    }
    if (files.length > 1) toast(`${files.length}枚を追加`);
  }

  go(delta) {
    const j = this.i + delta;
    if (j < 0 || j >= this.ids.length) return;
    this.i = j;
    this.tag = '';
    this.requestId = null;
    this.render();
  }

  async done() {
    const id = this.id;
    const sm = state.products.get(id);
    const pendingN = uploads.pendingFor(id).length;
    if (!pendingN && !(sm?.counts?.actual > 0)) {
      const ok = await choose('写真がまだありません', [{ label: 'このまま撮影完了にする', value: true }]);
      if (!ok) return;
    }
    const requestAi = state.prefs.camRequestAi;
    // Mark done only after this product's photos reached the server, so the AI sees them all.
    this.chain.then(() => waitUploaded(id)).then(async () => {
      try {
        applyProduct(await api.post(`/api/products/${id}/shoot-done`, { requestAi }));
      } catch (e) {
        showError(e);
      }
    });
    toast(`${sm?.name || id}: 撮影完了${requestAi ? '（AI整理を依頼）' : ''}`);
    if (state.prefs.camAutoNext) {
      if (this.i < this.ids.length - 1) this.go(1);
      else {
        toast('最後の商品です。お疲れさまでした');
        this.close();
      }
    }
  }

  async newProduct() {
    try {
      const { product } = await api.post('/api/products', { name: '' });
      applyProduct(product);
      this.ids.splice(this.i + 1, 0, product.id);
      this.full.set(product.id, product);
      this.go(1);
      toast(`新しい商品 ${product.id} を登録`);
    } catch (e) {
      showError(e);
    }
  }

  async photoMenu(ph) {
    const v = await choose(ph.tag ? `写真（${ph.tag}）` : '写真', [
      { label: 'タグを変更', value: 'tag' },
      { label: '削除（ゴミ箱へ）', value: 'delete', danger: true },
    ]);
    try {
      if (v === 'delete') {
        applyProduct(await api.del(`/api/products/${this.id}/photos/${ph.id}`));
        await this.loadFull(this.id, true);
      } else if (v === 'tag') {
        const t = await choose('タグ', [{ label: '（なし）', value: '' }, ...state.meta.photoTags.map((x) => ({ label: x, value: x }))]);
        if (t === undefined) return;
        applyProduct(await api.patch(`/api/products/${this.id}/photos/${ph.id}`, { tag: t }));
        await this.loadFull(this.id, true);
      }
    } catch (e) {
      showError(e);
    }
  }

  async pendingMenu(p) {
    const v = await choose(p.error ? `アップロード失敗: ${p.error}` : 'アップロード待ち', [
      { label: '再送する', value: 'retry' },
      { label: 'この写真を破棄', value: 'discard', danger: true },
    ]);
    if (v === 'retry') uploads.retryFailed();
    if (v === 'discard') uploads.discard(p.qid);
  }

  settings() {
    const toggle = (key, label) =>
      h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '10px' } },
        h('input', { type: 'checkbox', checked: !!state.prefs[key], style: { width: '22px', height: '22px' }, onchange: (e) => setPref(key, e.target.checked) }),
        h('span', null, label));
    sheet((close) =>
      h('div', null,
        h('h2', null, '撮影設定'),
        toggle('camAutoNext', '撮影完了で自動的に次の商品へ進む'),
        toggle('camRequestAi', '撮影完了でAI整理（整理→原稿→QC）を依頼する'),
        toggle('camKeepTag', '撮影後もタグを維持する（同じ部位を続けて撮る時）'),
        h('p', { class: 'muted small' }, 'シャッター長押しで連写。Mac ではスペース=撮影、←→=商品移動、Enter=撮影完了。'),
        h('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => close() }, '閉じる')));
  }
}

function waitUploaded(productId) {
  return new Promise((resolve) => {
    const check = () => {
      const left = uploads.pendingFor(productId).filter((p) => !p.error).length;
      if (!left) {
        off();
        resolve();
      }
    };
    const off = on('uploads', check);
    check();
  });
}
