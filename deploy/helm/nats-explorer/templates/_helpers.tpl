{{- define "nats-explorer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nats-explorer.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "nats-explorer.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "nats-explorer.labels" -}}
app.kubernetes.io/name: {{ include "nats-explorer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nats-explorer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nats-explorer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "nats-explorer.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{- define "nats-explorer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "nats-explorer.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* The path prefix, empty when served from the root. */}}
{{- define "nats-explorer.basePath" -}}
{{- $p := trimSuffix "/" (default "/" .Values.ingress.path) -}}
{{- if and .Values.ingress.enabled $p -}}{{ $p }}{{- end -}}
{{- end -}}

{{/* Secret and key holding AUTH_TOKEN. */}}
{{- define "nats-explorer.authSecretName" -}}
{{- .Values.auth.secretName | default (printf "%s-auth" (include "nats-explorer.fullname" .)) -}}
{{- end -}}

{{- define "nats-explorer.authSecretKey" -}}
{{- if .Values.auth.secretName }}{{ .Values.auth.secretKey | default "token" }}{{ else }}token{{ end -}}
{{- end -}}

{{/* "true" when the chart writes connections or settings into STORAGE_DIR. */}}
{{- define "nats-explorer.seedEnabled" -}}
{{- if or .Values.nats.enabled .Values.extraConnections .Values.seed.extraSettings }}true{{ end -}}
{{- end -}}

{{/* "true" when the server keeps settings in a file (seed or persistence). */}}
{{- define "nats-explorer.fileStorage" -}}
{{- if or (include "nats-explorer.seedEnabled" .) .Values.persistence.enabled }}true{{ end -}}
{{- end -}}

{{/*
Credentials for one auth method, as connection fields. `prefix` is "" for the
application account and "sys" for the system account (sysToken, sysUser ...).
*/}}
{{- define "nats-explorer.credentials" -}}
{{- $a := .auth }}
{{- $what := .what }}
{{- $f := dict }}
{{- $key := ternary "authMethod" "sysAuthMethod" (eq .prefix "") }}
{{- $_ := set $f $key $a.method }}
{{- $field := dict "token" "token" "user" "user" "pass" "pass" "nkeySeed" "nkeySeed" "creds" "creds" }}
{{- if ne .prefix "" }}
{{- $field = dict "token" "sysToken" "user" "sysUser" "pass" "sysPass" "nkeySeed" "sysNkeySeed" "creds" "sysCreds" }}
{{- end }}
{{- if eq $a.method "token" }}
{{- $_ := set $f $field.token (required (printf "%s.token is required for method token" $what) $a.token) }}
{{- else if eq $a.method "userpass" }}
{{- $_ := set $f $field.user (required (printf "%s.user is required for method userpass" $what) $a.user) }}
{{- $_ := set $f $field.pass (required (printf "%s.password is required for method userpass" $what) $a.password) }}
{{- else if eq $a.method "nkey" }}
{{- $_ := set $f $field.nkeySeed (required (printf "%s.nkeySeed is required for method nkey" $what) $a.nkeySeed) }}
{{- else if eq $a.method "jwt" }}
{{- $_ := set $f $field.creds (required (printf "%s.creds is required for method jwt" $what) $a.creds) }}
{{- else if ne $a.method "none" }}
{{- fail (printf "%s.method must be one of none, token, userpass, nkey, jwt (got %q)" $what $a.method) }}
{{- end }}
{{- toJson $f }}
{{- end -}}

{{/* The preconfigured connection to the in-cluster NATS, as the UI stores it. */}}
{{- define "nats-explorer.natsConnection" -}}
{{- $n := .Values.nats }}
{{- $ns := $n.namespace | default .Release.Namespace }}
{{- $servers := $n.servers }}
{{- if not $servers }}
{{- $servers = list (printf "nats://%s.%s.svc.%s:%d" $n.serviceName $ns $n.clusterDomain (int $n.port)) }}
{{- end }}
{{- $mon := $n.monitoringUrl }}
{{- if not $mon }}
{{- $mon = printf "http://%s-0.%s-headless.%s.svc.%s:%d" $n.serviceName $n.serviceName $ns $n.clusterDomain (int $n.monitorPort) }}
{{- end }}
{{- $c := dict "id" $n.id "name" $n.name "servers" $servers "subscriptions" $n.subscriptions "sysTopics" $n.systemTopics "monitoringUrl" $mon "autoConnect" $n.autoConnect }}
{{- $c = merge $c (include "nats-explorer.credentials" (dict "auth" $n.auth "prefix" "" "what" "nats.auth") | fromJson) }}
{{- if ne $n.systemAccount.method "none" }}
{{- $c = merge $c (include "nats-explorer.credentials" (dict "auth" $n.systemAccount "prefix" "sys" "what" "nats.systemAccount") | fromJson) }}
{{- end }}
{{- if $n.tls.enabled }}
{{- $_ := set $c "tls" true }}
{{- with $n.tls.ca }}{{ $_ := set $c "tlsCa" . }}{{ end }}
{{- with $n.tls.cert }}{{ $_ := set $c "tlsCert" . }}{{ end }}
{{- with $n.tls.key }}{{ $_ := set $c "tlsKey" . }}{{ end }}
{{- if $n.tls.insecureSkipVerify }}{{ $_ := set $c "tlsInsecure" true }}{{ end }}
{{- end }}
{{- with $n.jsDomain }}{{ $_ := set $c "jsDomain" . }}{{ end }}
{{- with $n.jsApiPrefix }}{{ $_ := set $c "jsApiPrefix" . }}{{ end }}
{{- toJson $c }}
{{- end -}}

{{/* All seeded connections as a JSON array. */}}
{{- define "nats-explorer.connections" -}}
{{- $list := list }}
{{- if .Values.nats.enabled }}
{{- $list = append $list (include "nats-explorer.natsConnection" . | fromJson) }}
{{- end }}
{{- range .Values.extraConnections }}
{{- $list = append $list . }}
{{- end }}
{{- toJson $list }}
{{- end -}}
