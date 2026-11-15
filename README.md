# Noise Division

Сайт музыкальной группы на TypeScript. В приложении доступны:

- регистрация и вход через API;
- загрузочный экран при проверке сессии;
- просмотр и редактирование профиля музыканта;
- групповой чат по WebSocket для авторизованных пользователей;
- выход из системы;
- адаптивная версия для мобильных устройств.

## Запуск

```bash
npm install
npm run dev
```

Production-сборка проверяется командами `npm run build` и `npm run lint`.

## API и деплой

Приложение использует ' https://inai-col3.fishrungames.com/api/docs '. Регистрация и вход
на эндпоинтах `/api/register/` и `/api/login/` возвращают access JWT, который
передаётся в заголовке `Authorization: Bearer`. Refresh JWT хранится backend в
HttpOnly cookie и используется через `/api/token/refresh/` для восстановления
сессии и автоматического обновления access-токена. Выход выполняется через
`/api/logout/`. Backend должен разрешать CORS-запросы с домена GitHub Pages
с credentials.


Workflow `.github/workflows/deploy.yml` собирает проект и публикует папку `dist`
через GitHub Pages при push в `main`. В настройках репозитория выберите
**Settings → Pages → Source: GitHub Actions**.
