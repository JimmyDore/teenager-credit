# Crédit ados

Suivi du crédit gagné par les ados lors des actions d'autofinancement, crédit
ensuite déduit des factures des familles. L'admin saisit tout : les actions
collectives (montant réparti entre les participants au prorata de leurs
parts) et les mouvements individuels (ajouts, déductions). Chaque famille
consulte le solde et l'historique de ses ados avec son code, sans jamais voir
ceux des autres familles. Tout tient dans un fichier `credits.json`.

- Familles : https://credit-ado.jimmydore.fr
- Admin : https://credit-ado.jimmydore.fr/admin

Spécification complète : [`docs/spec.md`](docs/spec.md).

## Dev

```bash
npm install
ADMIN_PASSWORD=secret npm start   # http://localhost:8787, données dans ./data
npm test                          # node --test (app + script de sauvegarde)
```

Un seul processus Fastify sert le front statique (`public/`) et l'API.

## Déploiement

Push sur `main` → GitHub Actions (tests puis SSH vers le serveur) → mise à
jour du dépôt dans `/root/credit-ado`, écriture de `.env` (`ADMIN_PASSWORD`),
`docker compose up -d --build` (conteneur unique `credit-ado-web`, réseau
partagé `ravetycoon_default`, données dans `/root/credit-ado-data`, TLS via
le Caddy de la stack ravetycoon) → health check sur
https://credit-ado.jimmydore.fr/health.

Secrets GitHub (Settings › Secrets and variables › Actions) :

| Secret | Rôle |
|---|---|
| `DEPLOY_SSH_KEY` | clé privée SSH pour `root@77.42.23.215` |
| `DEPLOY_KNOWN_HOSTS` | empreinte du serveur (`ssh-keyscan 77.42.23.215`) |
| `ADMIN_PASSWORD` | mot de passe admin, obligatoire (ni antislash ni retour à la ligne) ; le changer déconnecte l'admin |
| `SLACK_WEBHOOK_URL` | alerte en cas d'échec de sauvegarde |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | accès Cloudflare R2 (token limité au bucket) ; s'ils manquent, les sauvegardes sont désactivées |

Hors de ce dépôt :

- **DNS** : enregistrement A `credit-ado` → `77.42.23.215` (zone jimmydore.fr).
- **Caddy** : le bloc `credit-ado.jimmydore.fr { reverse_proxy credit-ado-web:8787 }`
  vit dans `deploy/Caddyfile` du dépôt RaveTycoon.

## Sauvegardes

Chaque nuit à 02:00 (`/etc/cron.d/credit-ado-backup`), `deploy/backup.sh`
copie `/root/credit-ado-data` vers
`r2:hetzner-backups/credit-ado/<YYYYMMDD_HHMMSS>/` avec un conteneur
`rclone/rclone` (rien d'installé sur l'hôte), puis supprime les copies de plus
de 365 jours sous ce préfixe. Pas de message quand tout va bien, un message
Slack en cas d'échec.

- Config rclone + webhook : `/root/.credit-ado-backup.env` (écrit par la CI)
- Logs : `/var/log/credit-ado-backup.log`
- Lancer une sauvegarde à la main : `/root/credit-ado/deploy/backup.sh`

Restaurer (sur le serveur) :

```bash
# Lister les sauvegardes disponibles
docker run --rm --env-file /root/.credit-ado-backup.env rclone/rclone:1 lsf r2:hetzner-backups/credit-ado/

docker stop credit-ado-web
docker run --rm --env-file /root/.credit-ado-backup.env -v /root/credit-ado-data:/data \
  rclone/rclone:1 copy r2:hetzner-backups/credit-ado/<DATE>/ /data
chown -R 1000:1000 /root/credit-ado-data
docker start credit-ado-web
```

## Nouvelle saison

Remise à zéro manuelle, hors de l'app, sur le serveur :

```bash
docker stop credit-ado-web
cd /root/credit-ado-data
mv credits.json credits-2026-2027.json   # archive (sauvegardée avec le reste)
docker start credit-ado-web              # credits.json est recréé vide
```

Puis changer `APP_TITLE` dans `docker-compose.yml` (ex. `Crédit ados
2027-2028`) et pousser sur `main`.
