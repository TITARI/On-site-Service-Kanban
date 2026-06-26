$env:PORT = "3000"
$env:HOSTNAME = "0.0.0.0"
$env:DATABASE_URL = "mysql://collaboration_board_app:replace-with-password@127.0.0.1:3306/collaboration_board"
$env:ADMIN_BOOTSTRAP_PASSWORD = "replace-with-long-random-bootstrap-password"
# Production keeps MariaDB failures hard-fail by default. Only enable for a planned emergency JSON fallback.
# $env:APP_ALLOW_JSON_FALLBACK = "true"
# Optional fixed public site URL. When set, WeChat ticket receipts use this instead of the temporary tunnel URL.
# $env:APP_PUBLIC_BASE_URL = "https://your-domain.example"

# Optional AI provider keys. Fill these if the admin page config uses the same env names.
# $env:ARK_API_KEY = "replace-with-ark-api-key"

# Optional MCP secrets. Fill these if the admin page config uses the same env names.
# $env:WECHAT_MCP_SECRET = "replace-with-wechat-secret"
# $env:WECOM_MCP_SECRET = "replace-with-wecom-secret"

# wxauto REST bridge settings.
# $env:WXAUTO_REST_BASE_URL = "http://127.0.0.1:8001"
# $env:WXAUTO_REST_TOKEN = "replace-with-wxauto-token"
# $env:WXAUTO_NAME = ""
# $env:WXAUTO_FILTER_MUTE = "false"
# $env:INTAKE_URL = "http://127.0.0.1:3000/api/integrations/wechat/messages"
# $env:OUTBOUND_URL = "http://127.0.0.1:3000/api/integrations/wechat/outbound"
# $env:INTAKE_SECRET = "replace-with-wechat-secret"
# $env:BRIDGE_POLL_INTERVAL_MS = "1200"
# $env:BRIDGE_OUTBOUND_POLL_INTERVAL_MS = "1500"
# $env:BRIDGE_DRY_RUN = "false"
