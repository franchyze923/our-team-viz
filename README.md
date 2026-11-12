# our-team-viz

An interactive globe showing where everyone on the team is based. Click a pin or a name to open a profile.

Static site, no build step and no backend: plain HTML, CSS and ES modules, with [globe.gl](https://github.com/vasturiano/globe.gl) vendored in `vendor/`.

## Run it

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or as a container (serves on 8080):

```sh
podman build -t our-team-viz .
podman run --rm -p 8080:8080 our-team-viz
```

## Edit the team

Everything comes from `data/team.json`. 
| Field | Notes |
| --- | --- |
| `id` | Unique slug. Also the deep link: `/#maya-chen` opens that profile. |
| `name` | Required. |
| `role`, `team`, `bio`, `email`, `region` | Optional. |
| `city`, `country` | Shown in the profile and used by search. |
| `lat`, `lng` | Decimal degrees. People within about 10 km share one pin. |
| `timezone` | IANA name such as `America/Chicago`. Drives the live local time. |
| `links` | Optional `github` / `linkedin` URLs (any other key is shown by its name). |
| `avatar` | Optional image URL or path. Initials are used when it is absent. |

The starting camera position is `HOME` at the top of `js/app.js`.

## Layout

```
index.html        page shell
css/styles.css    theme and layout
js/app.js         globe, roster, profile panel
data/team.json    the team
vendor/           globe.gl 2.46.2 and Natural Earth country outlines
```

## Adding Keycloak later

No backend is needed for login itself: load `keycloak-js`, create a public client with PKCE, and call
`keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256' })` before `main()` in `js/app.js`.

That only gates the UI. `data/team.json` would still be fetchable by anyone who can reach the server, so if the
data must be private, serve it from something that checks the token (oauth2-proxy in front of the whole site is
the least work).
