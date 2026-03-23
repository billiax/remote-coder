#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NS="remote-coder"

usage() {
  echo "Usage: $0 {install|update|uninstall|status}"
  echo ""
  echo "  install   - Create namespace, secrets, and deploy"
  echo "  update    - Re-apply manifests (after image or config changes)"
  echo "  uninstall - Remove all resources"
  echo "  status    - Show pods, service, ingress"
  exit 1
}

ensure_namespace() {
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
}

ensure_secrets() {
  if kubectl get secret remote-coder-secrets -n "$NS" &>/dev/null; then
    echo "Secret remote-coder-secrets already exists in $NS"
    return
  fi

  if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "ERROR: Set CLAUDE_CODE_OAUTH_TOKEN env var before running install"
    exit 1
  fi

  kubectl create secret generic remote-coder-secrets \
    --namespace "$NS" \
    --from-literal=claude-oauth-token="$CLAUDE_CODE_OAUTH_TOKEN"
  echo "Created remote-coder-secrets in $NS"
}

do_install() {
  echo "=== Creating namespace ==="
  ensure_namespace

  echo ""
  echo "=== Creating secrets ==="
  ensure_secrets

  echo ""
  echo "=== Applying manifests ==="
  kubectl apply -f "$SCRIPT_DIR/deployment.yaml"
  kubectl apply -f "$SCRIPT_DIR/service.yaml"
  kubectl apply -f "$SCRIPT_DIR/ingress.yaml"

  echo ""
  echo "Done. Check status with: $0 status"
}

do_update() {
  echo "=== Applying manifests ==="
  kubectl apply -f "$SCRIPT_DIR/deployment.yaml"
  kubectl apply -f "$SCRIPT_DIR/service.yaml"
  kubectl apply -f "$SCRIPT_DIR/ingress.yaml"

  echo ""
  echo "=== Restarting deployment ==="
  kubectl rollout restart deployment/remote-coder -n "$NS"
  kubectl rollout status deployment/remote-coder -n "$NS"
}

do_uninstall() {
  echo "=== Removing resources ==="
  kubectl delete -f "$SCRIPT_DIR/ingress.yaml" --ignore-not-found
  kubectl delete -f "$SCRIPT_DIR/service.yaml" --ignore-not-found
  kubectl delete -f "$SCRIPT_DIR/deployment.yaml" --ignore-not-found
  echo ""
  echo "Note: Namespace $NS and secrets were NOT deleted. Remove manually if needed."
}

do_status() {
  echo "=== Pods ==="
  kubectl get pods -n "$NS" -o wide 2>/dev/null || echo "  (namespace not found)"
  echo ""
  echo "=== Service ==="
  kubectl get svc -n "$NS" 2>/dev/null || echo "  (none)"
  echo ""
  echo "=== Ingress ==="
  kubectl get ingress -n "$NS" 2>/dev/null || echo "  (none)"
}

case "${1:-}" in
  install)   do_install ;;
  update)    do_update ;;
  uninstall) do_uninstall ;;
  status)    do_status ;;
  *)         usage ;;
esac
