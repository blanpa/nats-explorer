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
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "nats-explorer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nats-explorer.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The path prefix, empty when served from the root. */}}
{{- define "nats-explorer.basePath" -}}
{{- $p := trimSuffix "/" (default "/" .Values.ingress.path) -}}
{{- if and .Values.ingress.enabled $p -}}{{ $p }}{{- end -}}
{{- end -}}
