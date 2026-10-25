/* Woodline private workspace: Supabase Auth + optimistic-concurrency snapshots.
 * Only a public anon/publishable key belongs here. Never use a service-role key. */
(function (global) {
  'use strict';
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const id = () => global.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  class CloudError extends Error {
    constructor(message, code) { super(message); this.code = code; }
  }
  class WoodlineCloud {
    constructor(options = {}) {
      this.options = options;
      this.url = (options.url || '').replace(/\/$/, '');
      this.key = options.anonKey || '';
      if (this.key.startsWith('sb_secret_')) throw new Error('В браузере разрешён только публичный publishable/anon ключ Supabase.');
      try { if (this.key.split('.').length === 3 && JSON.parse(global.atob(this.key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role') throw new CloudError('Нельзя использовать административный service_role ключ в браузере.', 'unsafe-key'); } catch (error) { if (error.code === 'unsafe-key') throw error; }
      this.configured = !!(this.url && this.key);
      if (this.configured) {
        const url = new URL(this.url);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Нужен HTTPS URL проекта Supabase без пути.');
      }
      this.prefix = 'woodline:cloud:' + this.url + ':';
      this.session = null;
      this.revision = 0;
      this.remote = null;
      this.pending = null;
      this.ready = false;
      this.conflict = false;
      this.writerId = id();
      this.generation = 0;
      this.authAttempt = 0;
      this.status = 'signed-out';
      this.fetch = options.fetch || global.fetch.bind(global);
      try { this.storage = options.storage || global.localStorage; } catch (_) {}
      if (!this.storage) this.storage = { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); }, removeItem() {}, get length() { return 0; }, key() { return null; } };
      this.disposers = [];
      this.disposed = false;
    }
    get user() { return this.session?.user || null; }
    getSnapshot() { return { configured: this.configured, user: copy(this.user), revision: this.revision, pending: copy(this.pending?.payload), remote: copy(this.remote), status: this.status, ready: this.ready, conflict: this.conflict }; }
    emit(state, message) {
      this.status = state;
      if (state === 'offline' && this.pending?.durable === false) message += ' Черновик только в памяти: не закрывайте страницу и экспортируйте JSON.';
      this.options.onStatus?.({ state, message, user: copy(this.user), revision: this.revision, pending: !!this.pending, durable: !this.pending || this.pending.durable !== false });
    }
    validate(payload) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Данные доски должны быть JSON-объектом.');
      const text = JSON.stringify(payload);
      if (new TextEncoder().encode(text).length > 1900000) throw new Error('Доска превышает лимит 1,9 МБ. Экспортируйте резервную копию.');
      return this.options.validate ? this.options.validate(JSON.parse(text)) : JSON.parse(text);
    }
    assertAccount(generation, userId) {
      if (generation !== this.generation || userId !== this.user?.id || this.disposed) throw new CloudError('Аккаунт изменился. Действие отменено; данные прежнего аккаунта не открыты.', 'account');
    }
    scoped(suffix) { if (!this.user?.id) throw new Error('Сначала войдите.'); return this.prefix + this.user.id + ':' + suffix; }
    read(key) { const raw = this.storage.getItem(key); return raw ? JSON.parse(raw) : null; }
    write(key, value) { this.storage.setItem(key, JSON.stringify(value)); }
    notify(payload, meta) { this.options.onState?.(copy(payload), meta); }
    rememberSession() {
      try { if (this.session) this.write(this.prefix + 'session', this.session); else this.storage.removeItem(this.prefix + 'session'); }
      catch (_) { this.emit('storage-error', 'Браузер не сохраняет вход. Не закрывайте страницу до синхронизации и сохраните JSON.'); }
    }
    async request(path, { method = 'GET', body, auth = true, token } = {}) {
      if (auth && !token) { const generation = this.generation; await this.ensureToken(); if (generation !== this.generation || !this.session) throw new CloudError('Аккаунт изменился. Запрос не отправлен.', 'account'); token = this.session.access_token; }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeout || 15000);
      try {
        const response = await this.fetch(this.url + path, {
          method, signal: controller.signal,
          headers: { apikey: this.key, 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + token } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        });
        const text = await response.text();
        let result; try { result = text ? JSON.parse(text) : null; } catch (_) { throw new CloudError('Сервис вернул некорректный ответ. Данные не удалены.', 'response'); }
        if (!response.ok) {
          let code = response.status;
          const known = result?.error_code || result?.code || '';
          if (String(known).startsWith('refresh_token_')) code = 401;
          let message = code === 401 ? 'Вход истёк. Войдите снова; локальные изменения сохранены отдельно.' : code === 429 ? 'Слишком много запросов. Подождите немного и повторите.' : code >= 500 ? 'Облако временно недоступно. Изменения остаются на устройстве.' : 'Запрос не выполнен. Проверьте настройки облака и доступ к аккаунту.';
          if (known === 'invalid_credentials') message = 'Неверная почта или пароль.';
          if (known === 'email_not_confirmed') message = 'Подтвердите почту по ссылке из письма.';
          if (known === 'user_already_exists') message = 'Аккаунт уже существует. Войдите или восстановите пароль.';
          if (known === 'weak_password') message = 'Пароль слишком простой. Используйте не менее 8 символов.';
          if (code === 404) message = 'Облачная схема не установлена. Администратору нужно выполнить supabase/schema.sql.';
          throw new CloudError(message, code);
        }
        return result;
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError('Нет связи с облаком. Изменения на устройстве не удалены.', 'network');
      } finally { clearTimeout(timeout); }
    }
    async ensureToken() {
      if (!this.session?.access_token) throw new CloudError('Сначала войдите в аккаунт.', 401);
      if (this.session.expires_at && this.session.expires_at * 1000 > Date.now() + 60000) return;
      if (!this.session.refresh_token) throw new CloudError('Войдите снова. Локальные данные сохранены.', 401);
      if (!this.refreshing) {
        const token = this.session.refresh_token, generation = this.generation;
        this.refreshing = this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: token } }).then(session => {
          if (generation !== this.generation) throw new CloudError('Аккаунт изменился. Повторите действие.', 'account');
          this.session = { ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in };
          this.rememberSession();
        }).finally(() => { this.refreshing = null; });
      }
      await this.refreshing;
    }
    async init() {
      if (!this.configured) { this.emit('unconfigured', 'Облако не подключено. Пока данные хранятся только в этом браузере.'); return this.getSnapshot(); }
      if (!this.initialized) {
        const online = () => { this.sync().catch(() => {}); };
        const focus = () => { if (!global.document?.hidden) online(); };
        global.addEventListener?.('online', online); global.addEventListener?.('focus', focus);
        const sessionChanged = event => {
          if (event.key !== this.prefix + 'session' || !this.session) return;
          let next; try { next = event.newValue ? JSON.parse(event.newValue) : null; } catch (_) { return; }
          if (!next || next.user?.id !== this.user?.id) {
            this.generation++; clearTimeout(this.saveTimer); this.session = null; this.pending = null; this.remote = null; this.revision = 0; this.ready = false; this.conflict = false;
            this.options.onAuth?.(null); this.emit('signed-out', 'Аккаунт изменён в другой вкладке. Войдите снова. Черновики сохранены отдельно.');
          } else if (next.expires_at >= this.session.expires_at) this.session = next;
        };
        global.addEventListener?.('storage', sessionChanged);
        this.disposers.push(() => global.removeEventListener?.('online', online), () => global.removeEventListener?.('focus', focus), () => global.removeEventListener?.('storage', sessionChanged));
        this.poll = setInterval(focus, this.options.pollInterval || 15000);
        this.initialized = true;
      }
      const generation = this.generation;
      try {
        // Password recovery links are handled by Supabase; access tokens are removed from the URL immediately.
        const hash = new URLSearchParams((global.location?.hash || '').replace(/^#/, ''));
        if (hash.get('access_token') && hash.get('refresh_token')) {
          this.session = { access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token'), expires_at: Math.floor(Date.now() / 1000) + Number(hash.get('expires_in') || 3600) };
          this.recovery = hash.get('type') === 'recovery';
          global.history?.replaceState(null, '', global.location.pathname + global.location.search);
        } else this.session = this.read(this.prefix + 'session');
        if (!this.session) { this.emit('signed-out', 'Войдите, чтобы загрузить свою доску.'); return this.getSnapshot(); }
        await this.ensureToken();
        const user = await this.request('/auth/v1/user');
        if (generation !== this.generation || !this.session) return this.getSnapshot();
        this.session.user = user; this.rememberSession(); this.options.onAuth?.(copy(user));
        await this.loadAccount();
        if (this.recovery) this.emit('recovery', 'Ссылка подтверждена. Задайте новый пароль.');
      } catch (error) {
        if (generation !== this.generation) return this.getSnapshot();
        if (this.session?.user?.id && error.code === 'network') {
          this.options.onAuth?.(copy(this.user));
          this.loadLocal();
          this.emit('offline', 'Нет связи. Показана локальная копия аккаунта; облачная версия пока не проверена.');
        } else { if (error.code === 401) { this.session = null; this.rememberSession(); this.options.onAuth?.(null); } this.emit(error.code === 401 ? 'signed-out' : 'error', error.message); }
      }
      return this.getSnapshot();
    }
    async signUp(email, password) {
      this.checkCredentials(email, password);
      const attempt = ++this.authAttempt;
      const result = await this.request('/auth/v1/signup', { method: 'POST', auth: false, body: { email: email.trim(), password } });
      if (attempt !== this.authAttempt || this.disposed) return this.getSnapshot();
      if (result?.access_token) return this.acceptSession(result);
      this.emit('confirmation', 'Проверьте почту и подтвердите регистрацию. Затем войдите.');
      return { confirmationRequired: true };
    }
    checkCredentials(email, password) {
      if (!this.configured) throw new Error('Облако ещё не настроено.');
      if (!String(email).trim() || !String(email).includes('@')) throw new Error('Введите почту.');
      if (typeof password !== 'string' || password.length < 8) throw new Error('Используйте пароль не короче 8 символов.');
    }
    async signIn(email, password) {
      this.checkCredentials(email, password);
      const attempt = ++this.authAttempt;
      const session = await this.request('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: email.trim(), password } });
      if (attempt !== this.authAttempt || this.disposed) return this.getSnapshot();
      return this.acceptSession(session);
    }
    async acceptSession(session) {
      this.recovery = false;
      this.generation++; clearTimeout(this.saveTimer);
      this.session = { ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in };
      if (!this.session.user?.id) { const generation = this.generation; const user = await this.request('/auth/v1/user'); if (generation !== this.generation || !this.session) return this.getSnapshot(); this.session.user = user; }
      this.remote = null; this.pending = null; this.revision = 0; this.ready = false; this.conflict = false;
      this.rememberSession(); this.options.onAuth?.(copy(this.user));
      await this.loadAccount(); return this.getSnapshot();
    }
    loadLocal() {
      this.remote = null; this.revision = 0; this.ready = false; this.pending = null; this.conflict = false;
      try {
        const cache = this.read(this.scoped('cache'));
        if (cache) { this.remote = cache.payload == null ? null : this.validate(cache.payload); this.revision = cache.revision; this.ready = true; }
        const drafts = [];
        const prefix = this.scoped('outbox:');
        for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key?.startsWith(prefix)) { const draft = this.read(key); this.validate(draft.payload); drafts.push(draft); } }
        drafts.sort((a, b) => b.createdAt - a.createdAt);
        if (drafts.length) {
          this.pending = drafts[0]; this.pending.durable = true; this.ready = true;
          // Old records by one writer are superseded by its newest complete snapshot, but other writers require review.
          const writers = new Set(drafts.map(x => x.writerId));
          this.multipleDrafts = writers.size > 1;
          this.conflict = this.multipleDrafts;
          if (!this.multipleDrafts) for (const draft of drafts.slice(1)) this.storage.removeItem(this.scoped('outbox:' + draft.id));
        }
        if (this.pending) this.notify(this.pending.payload, { source: 'pending', revision: this.pending.baseRevision, offline: true });
        else if (cache) this.notify(this.remote, { source: 'cache', revision: this.revision, offline: true, empty: !this.remote });
      } catch (_) { this.emit('storage-error', 'Локальная копия недоступна или повреждена. Исходные записи не удалены.'); }
    }
    async loadAccount() {
      this.loadLocal();
      const generation = this.generation;
      this.emit('loading', 'Проверяем облачную версию…');
      try {
        const remote = await this.fetchRemote();
        if (generation !== this.generation || !this.user) return;
        this.applyRemote(remote);
        if (this.pending) {
          if (this.multipleDrafts || this.pending.baseRevision !== this.revision) {
            if (!this.multipleDrafts && same(this.pending.payload, this.remote)) this.clearPending();
            else { this.conflict = true; this.emit('conflict', 'Есть разные версии доски. Выберите версию; ни одна не перезаписана автоматически.'); return; }
          }
          await this.sync();
        } else { this.notify(this.remote, { source: 'cloud', revision: this.revision, empty: !this.remote }); this.emit('synced', this.remote ? 'Облачная версия загружена.' : 'Облачная доска пока пустая. Выберите, какие данные загрузить.'); }
      } catch (error) { this.emit(error.code === 'network' ? 'offline' : 'error', error.message); }
    }
    async fetchRemote() {
      const generation = this.generation, userId = this.user?.id;
      const rows = await this.request('/rest/v1/woodline_boards?select=payload,revision,updated_at,mutation_id&owner=eq.' + encodeURIComponent(this.user.id));
      this.assertAccount(generation, userId);
      if (!Array.isArray(rows)) throw new Error('Некорректный ответ базы.');
      if (!rows.length) return { payload: null, revision: 0 };
      return { ...rows[0], payload: this.validate(rows[0].payload) };
    }
    applyRemote(remote) {
      this.remote = copy(remote.payload); this.revision = Number(remote.revision); this.ready = true;
      try { this.write(this.scoped('cache'), { ...remote, payload: this.remote }); } catch (_) { /* The server remains authoritative when local caching is unavailable. */ }
    }
    persistDraft(draft) {
      try { this.write(this.scoped('outbox:' + draft.id), draft); draft.durable = true; }
      catch (_) { draft.durable = false; }
    }
    async save(payload) {
      if (!this.user) throw new Error('Для облачного сохранения войдите в аккаунт.');
      if (!this.ready) throw new Error('Сначала дождитесь загрузки доски.');
      const previous = this.pending;
      const draft = { id: id(), writerId: this.writerId, payload: this.validate(payload), baseRevision: previous?.baseRevision ?? this.revision, createdAt: this.lastDraftAt = Math.max(Date.now(), (this.lastDraftAt || previous?.createdAt || 0) + 1) };
      this.persistDraft(draft); this.pending = draft;
      if (previous?.durable && draft.durable && !this.multipleDrafts) {
        try { this.storage.removeItem(this.scoped('outbox:' + previous.id)); } catch (_) {}
      }
      if (this.conflict) { this.emit('conflict', 'Изменения сохранены как локальный черновик. Сначала разрешите конфликт версий.'); return this.getSnapshot(); }
      this.emit(draft.durable ? 'pending' : 'storage-error', draft.durable ? 'Сохранено на устройстве. Отправляем в облако…' : 'Локальная запись недоступна. Не закрывайте вкладку до облачного сохранения; экспортируйте JSON.');
      clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.sync().catch(() => {}), this.options.debounce ?? 600);
      return this.getSnapshot();
    }
    clearPending() {
      if (this.pending) { try { const current = this.pending; for (const draft of this.listRecoveryDrafts(false)) if (draft.id === current.id || draft.writerId === current.writerId && draft.createdAt <= current.createdAt) this.storage.removeItem(this.scoped('outbox:' + draft.id)); } catch (_) {} }
      this.pending = null; this.conflict = false; this.multipleDrafts = false;
    }
    async sync() {
      if (this.disposed || !this.user || !this.configured || this.conflict) return this.getSnapshot();
      if (this.syncPromise) return this.syncPromise;
      const generation = this.generation;
      this.syncPromise = (async () => {
        try {
          if (!this.pending) {
            const remote = await this.fetchRemote();
            if (generation !== this.generation || !this.user) return;
            // A local edit made while fetching must be checked against the fetched revision.
            if (this.pending) {
              if (this.pending.baseRevision !== Number(remote.revision)) { this.applyRemote(remote); this.conflict = true; this.emit('conflict', 'Другое устройство изменило доску. Выберите версию.'); return; }
            } else {
              const changed = this.revision !== Number(remote.revision) || !same(this.remote, remote.payload);
              this.applyRemote(remote);
              if (changed) this.notify(this.remote, { source: 'cloud', revision: this.revision, empty: !this.remote });
            }
          }
          while (this.pending && !this.conflict && generation === this.generation) {
            const draft = copy(this.pending);
            this.emit('syncing', 'Сохраняем в облако…');
            const result = await this.request('/rest/v1/rpc/woodline_save_board', { method: 'POST', body: { p_payload: draft.payload, p_expected_revision: draft.baseRevision, p_mutation_id: draft.id } });
            if (generation !== this.generation || !this.user) return;
            if (!result || typeof result.conflict !== 'boolean') throw new Error('Некорректный ответ сохранения.');
            const remote = result.board || { payload: null, revision: 0 };
            if (remote.payload !== null) remote.payload = this.validate(remote.payload);
            this.applyRemote(remote);
            if (result.conflict && !same(this.pending.payload, this.remote)) {
              this.conflict = true; this.emit('conflict', 'Другое устройство уже сохранило новую версию. Ваш черновик сохранён отдельно.'); return;
            }
            if (this.pending.id === draft.id) this.clearPending();
            else {
              this.pending.baseRevision = this.revision;
              this.persistDraft(this.pending);
              try { this.storage.removeItem(this.scoped('outbox:' + draft.id)); } catch (_) {}
            }
          }
          if (!this.pending && generation === this.generation) this.emit('synced', 'Все изменения сохранены в облаке.');
        } catch (error) { if (generation === this.generation) this.emit(error.code === 'network' ? 'offline' : 'error', error.message); }
      })().finally(() => { this.syncPromise = null; });
      await this.syncPromise; return this.getSnapshot();
    }
    async resolveConflict(choice) {
      if (!this.user || !this.conflict) return this.getSnapshot();
      if (!['remote', 'local'].includes(choice)) throw new Error('Выберите локальную или облачную версию.');
      const generation = this.generation, userId = this.user.id;
      const latest = await this.fetchRemote();
      this.assertAccount(generation, userId);
      // Archive every pending snapshot before choosing a winner. If archiving fails, do not discard any copy.
      const drafts = this.listRecoveryDrafts(false);
      for (const draft of drafts) this.write(this.scoped('archive:' + draft.id), draft);
      if (choice === 'local' && latest.payload) this.write(this.scoped('archive:remote-' + id()), { payload: latest.payload, revision: latest.revision, createdAt: Date.now(), source: 'remote' });
      this.applyRemote(latest);
      const local = copy(this.pending?.payload);
      for (const draft of drafts) this.storage.removeItem(this.scoped('outbox:' + draft.id));
      this.pending = null; this.conflict = false; this.multipleDrafts = false;
      if (choice === 'remote') { this.notify(this.remote, { source: 'cloud', revision: this.revision, empty: !this.remote }); this.emit('synced', 'Загружена облачная версия. Предыдущий локальный черновик оставлен в архиве устройства.'); }
      else if (local) { await this.save(local); await this.sync(); }
      return this.getSnapshot();
    }
    listRecoveryDrafts(includeArchive = true) {
      if (!this.user) return [];
      const prefix = this.scoped(''); const results = [];
      for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key?.startsWith(prefix + 'outbox:') || includeArchive && key?.startsWith(prefix + 'archive:')) { const draft = this.read(key); if (draft) results.push(copy(draft)); } }
      return results;
    }
    async listHistory() {
      if (!this.user) throw new Error('Сначала войдите.');
      const generation = this.generation, userId = this.user.id;
      const result = await this.request('/rest/v1/woodline_board_history?select=revision,updated_at&owner=eq.' + encodeURIComponent(userId) + '&order=revision.desc&limit=50');
      this.assertAccount(generation, userId);
      return result;
    }
    async getRevision(revision) {
      if (!this.user) throw new Error('Сначала войдите.');
      if (!Number.isInteger(Number(revision)) || Number(revision) < 1) throw new Error('Некорректная версия.');
      const generation = this.generation, userId = this.user.id;
      const rows = await this.request('/rest/v1/woodline_board_history?select=payload,revision,updated_at&owner=eq.' + encodeURIComponent(userId) + '&revision=eq.' + Number(revision));
      this.assertAccount(generation, userId);
      if (!rows?.length) throw new Error('Версия не найдена или уже вышла из последних 50 сохранений.');
      return { ...rows[0], payload: this.validate(rows[0].payload) };
    }
    async resetPassword(email) {
      if (!this.configured) throw new Error('Облако ещё не настроено.');
      if (!String(email).includes('@')) throw new Error('Введите почту аккаунта.');
      const redirect = this.options.redirectTo || (global.location ? global.location.origin + global.location.pathname : '');
      await this.request('/auth/v1/recover' + (redirect ? '?redirect_to=' + encodeURIComponent(redirect) : ''), { method: 'POST', auth: false, body: { email: email.trim() } });
      this.emit('confirmation', 'Если аккаунт существует, письмо для восстановления отправлено. Проверьте также «Спам».');
    }
    async updatePassword(password) {
      if (typeof password !== 'string' || password.length < 8) throw new Error('Используйте пароль не короче 8 символов.');
      const generation = this.generation, userId = this.user?.id;
      await this.request('/auth/v1/user', { method: 'PUT', body: { password } });
      this.assertAccount(generation, userId);
      this.recovery = false; this.emit('password-updated', 'Пароль обновлён. Статус доски проверяется отдельно.');
    }
    async signOut() {
      this.authAttempt++;
      this.recovery = false;
      const token = this.session?.access_token;
      this.generation++; clearTimeout(this.saveTimer);
      this.session = null; this.pending = null; this.remote = null; this.revision = 0; this.ready = false; this.conflict = false;
      this.rememberSession(); this.options.onAuth?.(null); this.emit('signed-out', 'Вы вышли. Черновики этого аккаунта остаются только на его устройстве.');
      if (token) try { await this.request('/auth/v1/logout?scope=local', { method: 'POST', token }); } catch (_) { /* Local sign-out is complete even without a network. */ }
    }
    dispose() { this.disposed = true; this.generation++; clearTimeout(this.saveTimer); clearInterval(this.poll); this.disposers.forEach(fn => fn()); }
  }
  global.WoodlineCloud = WoodlineCloud;
  if (typeof module !== 'undefined' && module.exports) module.exports = { WoodlineCloud, CloudError };
})(typeof window !== 'undefined' ? window : globalThis);
