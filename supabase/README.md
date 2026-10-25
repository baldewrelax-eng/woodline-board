# Настройка общей базы Woodline

Клиент `cloud-sync.js` реализует вход по почте и паролю и хранение одной приватной доски на аккаунт Supabase. На телефоне и компьютере нужно входить в **один аккаунт**. Разные пользователи имеют разные доски; совместные команды и приглашения в этой версии не реализованы.

Облако не считается подключённым до выполнения схемы и проверки реального входа и сохранения на двух устройствах. Модуль без конфигурации честно показывает локальный режим; анонимные данные автоматически в аккаунт не отправляются.

## Подключение

1. Создать бесплатный проект Supabase. Сохранить пароль базы в своём менеджере паролей; он не нужен сайту.
2. Выполнить `supabase/schema.sql` в SQL Editor от владельца проекта. Схема создаёт приватную таблицу с RLS и функцию атомарного сохранения с проверкой ревизии. При повторном выполнении данные не удаляются.
3. В Authentication → URL Configuration задать Site URL и разрешённый redirect URL: `https://baldewrelax-eng.github.io/woodline-board/` (с завершающим `/`). Это нужно для подтверждения почты и восстановления пароля. Включить Email/Password. Подтверждение почты рекомендуется сохранить включённым.
4. Взять Project URL и **anon / publishable** API key. Они предназначены для браузера и не являются административными секретами. Настроить их в конфигурации приложения, как описано в корневом README. **Никогда не вставлять service_role / secret API key, пароль БД или пользовательский пароль в публичный репозиторий.**
5. Зарегистрировать почту, подтвердить её, войти. Если облачная доска пустая, явно выбрать загрузку локальной доски либо создать новую. Одинаковая почта и пароль на обоих устройствах открывают одну доску.
6. Проверить: изменить задачу на компьютере, дождаться «Все изменения сохранены в облаке», открыть на телефоне; затем внести изменение на телефоне и дождаться его на компьютере. Обновления проверяются при возвращении во вкладку, восстановлении сети и каждые 15 секунд.

Для ежедневной доставки писем проверьте лимиты встроенного Supabase SMTP и при необходимости подключите свой SMTP. Бесплатный сервис может приостанавливать неактивные проекты и не гарантирует SLA: гарантировать отсутствие любых потерь нельзя. Держите независимые JSON-копии, особенно перед импортом/массовыми изменениями. Тарифы и квоты сервиса могут меняться.

## Как защищены изменения

- RLS разрешает чтение только владельцу: `auth.uid() = owner`. Анонимам таблица недоступна.
- Запись возможна только через `woodline_save_board` с проверкой текущей ревизии. Прямые `INSERT/UPDATE/DELETE` для клиентских ролей запрещены.
- При одновременных правках приложение не перетирает чужую версию: появляется выбор между локальной и облачной копиями. Автоматического слияния текстов нет.
- Непереданные изменения записываются в локальную очередь, привязанную к URL проекта и ID пользователя. Выход не удаляет черновики аккаунта и не выдаёт их следующему аккаунту.
- При выборе версии отвергнутая копия остаётся в локальном архиве; `listRecoveryDrafts()` возвращает эти записи для экспорта. Это дополнительная защита устройства, а не независимый облачный backup.
- В облаке хранятся последние 50 версий доски. `listHistory()` возвращает список версий, `getRevision(revision)` — валидированный снимок. Восстановление выполняется явным вызовом `save(snapshot.payload)` после подтверждения пользователя; действует та же проверка конфликтов. Это не заменяет независимый backup.
- Запросы идемпотентны по `mutation_id`: повтор после обрыва не создаёт лишнюю ревизию.
- Сессия хранится в браузере. Защита от XSS обязательна: пользовательские данные отображать через `textContent`/`.value`, не через `innerHTML`; не подключать недоверенные скрипты. На общем компьютере нужно выходить из аккаунта. Локальные копии на устройстве сохраняются после выхода, поэтому это устройство должно быть доверенным.

## API интеграции

```js
const cloud = new WoodlineCloud({
  url: 'https://PROJECT.supabase.co',
  anonKey: 'PUBLIC_ANON_OR_PUBLISHABLE_KEY',
  validate: WoodlineModel.validate,
  onAuth(user) { /* user or null; reset display when account changes */ },
  onState(board, meta) { /* board null = empty cloud board, never auto-upload local data */ },
  onStatus(status) { /* show exact status.message; synced is the only cloud-saved claim */ }
});
await cloud.init();
```

Methods: `signUp(email,password)`, `signIn(email,password)`, `signOut()`, `save(board)`, `sync()`, `resolveConflict('local'|'remote')`, `resetPassword(email)`, `updatePassword(password)`, `listRecoveryDrafts()`, `listHistory()`, `getRevision(revision)`, `getSnapshot()`, `dispose()`.

`save()` writes the durable local outbox first and schedules a network sync. `getSnapshot()` returns `{configured,user,revision,pending,remote,status,ready,conflict}`. `pending`/`remote` are complete board payloads or null. `onState(payload,{source,revision,empty?,offline?})` uses source `cache`, `pending`, or `cloud`. `onStatus({state,message,user,revision,pending,durable})` states include `unconfigured`, `signed-out`, `loading`, `pending`, `syncing`, `synced`, `offline`, `conflict`, `error`, `storage-error`, `confirmation`, `recovery`, `password-updated`.

`onAuth(null)` must remove the previous authenticated board from the visible UI. Do not copy account data into anonymous localStorage. `save()` must only be called after `ready` is true. Imported JSON must be validated by the model before `save()`.

Recovery links with tokens are consumed from the URL fragment and removed immediately. If status is `recovery`, ask the user for a new password and call `updatePassword`; do not log, save to application JSON, or export auth tokens. Use an HTTPS site in production.

Восстановление пароля переключайте по `cloud.recovery`, а не по последнему статусу синхронизации: опрос облака может обновить текст статуса, пока пользователь вводит новый пароль.

## Проверки реализации

```sh
node --test supabase/cloud-sync.test.cjs
```

Этот набор проверяет протокол с имитацией Auth/REST: два устройства, офлайн-очередь после перезапуска, конфликты, смену аккаунта, истечение входа и поздние ответы после выхода. Это не проверка живого сервиса или доставки почты.

SQL можно проверить локальным PostgreSQL-движком PGlite без подключения рабочей базы:

```sh
npm install --prefix /tmp/woodline-sql --cache /tmp/woodline-npm-cache @electric-sql/pglite --no-audit --no-fund
PGLITE_MODULE=/tmp/woodline-sql/node_modules/@electric-sql/pglite node --test supabase/schema.test.cjs
```

SQL-проверки выполняют настоящую схему, проверяют владельцев/RLS, запрет прямых записей, compare-and-swap, повтор запроса и ограничение истории. Заглушка `auth.uid()` в тестах заменяет только проверенный Supabase JWT; реальный Supabase Auth дополнительно нужно проверить после настройки проекта.
