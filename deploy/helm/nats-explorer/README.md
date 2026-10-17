# NATS Explorer Helm chart

Deploys [NATS Explorer](https://github.com/blanpa/nats-explorer) into Kubernetes, preconfigured for a NATS cluster that runs in the same Kubernetes cluster (installed with the official [NATS chart](https://github.com/nats-io/k8s)). After the install the UI already lists a connection to that cluster, including the monitoring endpoint and, if configured, the system account for the cluster view, and the server connects to it at start.

## Quick start: NATS cluster + NATS Explorer

[`examples/nats-cluster/`](examples/nats-cluster) contains values for both charts that fit together: a three-node NATS cluster with JetStream, an application account `APP` and the system account `SYS`. Change the passwords in both files first.

```bash
helm repo add nats https://nats-io.github.io/k8s/helm/charts/
helm install nats nats/nats -n messaging --create-namespace \
  -f deploy/helm/nats-explorer/examples/nats-cluster/nats.values.yaml

helm install explorer deploy/helm/nats-explorer -n messaging \
  -f deploy/helm/nats-explorer/examples/nats-cluster/explorer.values.yaml

kubectl -n messaging get secret explorer-nats-explorer-auth -o jsonpath='{.data.token}' | base64 -d; echo
kubectl -n messaging port-forward svc/explorer-nats-explorer 3002:3002
```

Open http://localhost:3002, enter the token, and pick *NATS cluster*. The cluster view shows all three nodes, the JetStream meta leader and where every stream's replicas live.

Resources are named `<release>-nats-explorer` (or `fullnameOverride`).

## How the preconfiguration works

| Derived from `nats.serviceName` (`nats`) and the release namespace | Value |
|---|---|
| Server URL | `nats://nats.<namespace>.svc.cluster.local:4222` |
| Monitoring URL | `http://nats-0.nats-headless.<namespace>.svc.cluster.local:8222` |

- The NATS chart names its services after the release (`nats` for a release called `nats`, `<release>-nats` otherwise). Set `nats.serviceName` and, for another namespace, `nats.namespace`. Use `nats.servers` and `nats.monitoringUrl` to override the derived URLs, for example for a NATS server outside the cluster.
- Monitoring is pinned to the first pod so that rate charts don't jump between nodes. The cluster-wide view comes from the system account, not from that URL.
- Without `nats.systemAccount` the cluster view shows only the node the connection landed on.
- `nats.autoConnect` (default on) connects at server start, so the history records from the start and not only once a browser opened the connection.

The chart writes the connections into the server's settings storage (`STORAGE_DIR`, by default `/data`). This has some consequences:

- **Shared state.** Everybody using the installation sees the same connections and request templates, and anyone who may use the UI can use the stored NATS credentials. Give UI access only to people who may use those credentials.
- **Without persistence (default)** the storage is an `emptyDir`. The seed is applied on every pod start, and changes made in the UI are lost on restart. Changing the values rolls the pod.
- **With `persistence.enabled`** the seed is written only to an empty volume. Connections and templates added in the UI survive restarts. To apply changed connection values, set `seed.overwrite=true` for one upgrade. That replaces everything stored, including templates added in the UI.

Credentials go into a Kubernetes Secret (`<fullname>-seed`). For a `.creds` file or TLS material use `--set-file`:

```bash
helm upgrade --install explorer deploy/helm/nats-explorer -n messaging \
  --set nats.auth.method=jwt --set-file nats.auth.creds=./explorer.creds \
  --set nats.systemAccount.method=jwt --set-file nats.systemAccount.creds=./sys.creds
```

Without a NATS cluster beside it, `nats.enabled=false` installs the explorer on its own; the UI then keeps connections in the browser unless persistence is on.

## Operating notes

- **One replica, always.** NATS connections, subscriptions and the recorded history live in the server process, so the chart does not offer `replicaCount` and uses the `Recreate` strategy.
- **Access.** `auth.mode=token` (default) requires a token for the API and the websocket. Without `auth.token` a random token is generated and kept on upgrades; `auth.secretName`/`auth.secretKey` use your own Secret. `auth.mode=users` reads `name:role:bcrypt-hash` lines from the `users` key of `auth.usersSecretName`. Single sign-on is configured with the `OIDC_*` variables in `env` (see [deployment](../../../docs/deployment.md)).
- **Ingress.** `ingress.path` other than `/` is passed as `BASE_PATH`, so the explorer can live under a prefix without a rewrite annotation. The websocket is pinged every 54 s, so the default proxy timeouts are fine.
- **History.** `config.historyMb` is the in-memory budget; with persistence, `config.persistHistory` keeps a SQLite copy on the volume for `config.historyRetention`.
- **Security context.** The chart runs as user 65532 with a read-only root filesystem, a `RuntimeDefault` seccomp profile and all capabilities dropped. `/tmp` and the storage directory are writable volumes. The pod does not mount a service account token.
- `helm test <release>` checks that the service answers.

## Upgrading from chart 0.1.0

`auth.mode` now defaults to `token` and `nats.enabled` to `true`. Set `auth.mode=none` and `nats.enabled=false` to keep the old behaviour. Resource names, the auth secret (`<fullname>-auth`) and the volume are unchanged.

## Values

| Key | Default | Description |
|---|---|---|
| `image.repository` / `image.tag` | `ghcr.io/blanpa/nats-explorer` / appVersion | Image |
| `auth.mode` | `token` | `token`, `users` or `none` |
| `auth.token` | `""` | Fixed token; generated when empty |
| `auth.secretName` / `auth.secretKey` | `""` / `token` | Read the token from an existing Secret |
| `auth.usersSecretName` | `""` | Secret with a `users` key, for `auth.mode=users` |
| `nats.enabled` | `true` | Preconfigure the in-cluster NATS connection |
| `nats.name` / `nats.id` | `NATS cluster` / `nats-cluster` | Name in the UI, stable id |
| `nats.autoConnect` | `true` | Connect when the server starts |
| `nats.serviceName` / `nats.namespace` | `nats` / release namespace | Service of the NATS chart |
| `nats.port` / `nats.monitorPort` | `4222` / `8222` | Client and monitoring ports |
| `nats.servers` / `nats.monitoringUrl` | derived | Override the derived URLs |
| `nats.subscriptions` | `[">"]` | Subjects of the subject tree |
| `nats.systemTopics.{sys,js,kv,srv}` | `false` | Also subscribe to `$SYS.>`, `$JS.>`, `$KV.>`, `$SRV.>` |
| `nats.jsDomain` / `nats.jsApiPrefix` | `""` | JetStream domain or API prefix |
| `nats.auth.method` | `none` | `none`, `token`, `userpass`, `nkey`, `jwt`, plus `token`, `user`, `password`, `nkeySeed`, `creds` |
| `nats.systemAccount.method` | `none` | Same fields, for the system account (cluster view) |
| `nats.tls.enabled` | `false` | TLS, with `ca`, `cert`, `key` (PEM) and `insecureSkipVerify` |
| `extraConnections` | `[]` | More connections in the UI's storage format |
| `seed.overwrite` | `false` | Replace the stored settings on every start |
| `seed.extraSettings` | `{}` | More `ne.*` settings to seed |
| `config.historyMb` | `256` | Memory budget for the recorded history (MB) |
| `config.persistHistory` / `config.historyRetention` | `false` / `72h` | SQLite copy of the history on the volume |
| `config.extraEnv` | `{}` | More environment as `name: value` |
| `env` | `[]` | More environment as a list (supports `valueFrom`) |
| `persistence.enabled` | `false` | Keep the storage directory on a PersistentVolumeClaim |
| `persistence.size` / `storageClass` / `accessMode` | `5Gi` / `""` / `ReadWriteOnce` | Volume options |
| `persistence.existingClaim` / `annotations` / `mountPath` | `""` / `{}` / `/data` | Use an existing claim, PVC annotations, mount path |
| `service.type` / `service.port` / `service.annotations` | `ClusterIP` / `3002` / `{}` | Service |
| `ingress.enabled` / `className` / `host` / `path` / `tls` / `annotations` | `false`, path `/` | Ingress; a path other than `/` becomes `BASE_PATH` |
| `serviceAccount.create` / `name` / `annotations` | `true` | ServiceAccount (its token is not mounted) |
| `resources` | 100m / 256Mi requests, 1Gi limit | Container resources |
| `podSecurityContext` / `securityContext` | non-root 65532, read-only root FS | Security contexts |
| `podAnnotations` / `podLabels` | `{}` | Pod metadata |
| `nodeSelector` / `tolerations` / `affinity` / `priorityClassName` | empty | Scheduling |
