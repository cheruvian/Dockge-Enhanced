# Monitoring webhooks

Dockge Enhanced can POST JSON notifications to up to five operator-configured
HTTP or HTTPS endpoints. Use a receiver such as an n8n Webhook Trigger to route
container alerts to email, SMS, or another service. No additional monitoring
container is required.

## Configure delivery

The existing authenticated `POST /api/monitoring/settings` endpoint accepts a
`webhooks` array. Configuration is API-only; the Monitoring tab continues to
manage the existing Discord and Apprise channels. Its settings saves preserve
this additional field.

```json
{
  "healthcheckEnabled": true,
  "healthcheckAutoHealMode": "notify",
  "crashLoopEnabled": true,
  "webhooks": [
    {
      "url": "https://automation.example.com/webhook/container-alerts",
      "secret": "YOUR_SHARED_SIGNING_SECRET"
    }
  ]
}
```

Use the same authentication as the other `/api/monitoring` endpoints. `secret` is
optional. HTTP endpoints on a private container network are supported. Use HTTPS
when sending across an untrusted network. URL userinfo and fragments are rejected;
query tokens are preserved. Settings contain credentials and are stored with
owner-only file permissions. Do not commit a populated configuration.

Send an authenticated `POST /api/monitoring/webhooks/test` to test the saved
destinations. The response includes `ok` and a `deliveries` array with a zero-based
destination index, success, attempt count, and HTTP status when available.
An empty destination list returns `ok: false`. Configuration errors return HTTP
400; delivery failures appear as `ok: false` in the test result.

## Event contract

```json
{
  "schemaVersion": 1,
  "id": "08a83b0a-c335-41a5-aa67-3429621b701e",
  "type": "container.unhealthy",
  "timestamp": "2026-10-23T20:00:00.000Z",
  "source": "dockge-enhanced",
  "hostname": "docker-host",
  "data": {
    "containerName": "photos-api",
    "containerId": "container-id",
    "stackName": "photos",
    "serviceName": "api",
    "healthStatus": "unhealthy",
    "action": "notify",
    "actionStatus": "notified",
    "message": "Notification only",
    "timestamp": "2026-10-23T20:00:00.000Z"
  }
}
```

Event types:

- `container.unhealthy`: the existing health watcher observes an unhealthy
  transition. `data` contains the health event and any configured healing result.
- `container.crash_loop`: the configured restart threshold is reached. `data`
  contains container name/ID, restart count, time window, and timestamp.
- `notification.test`: a test requested through the authenticated API.

The existing watcher thresholds, exclusions, and cooldowns govern event creation.
This feature does not add stopped-container alerts, recovery events, an initial
scan of already-unhealthy containers, or host-outage detection.

## Verify signatures and handle retries

Every request includes `X-Dockge-Event-Id` and `X-Dockge-Timestamp` (Unix seconds).
When a signing secret is configured, `X-Dockge-Signature` contains:

```text
sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw_request_body)>
```

Verify using the raw body and a constant-time comparison. Reject stale timestamps
(for example, older than five minutes). Deduplicate by event ID: a receiver can
accept a request even when its response is lost, causing a retry. A receiver
should acknowledge quickly and queue longer work.

Each destination receives at most three attempts, with a five-second request
timeout and one/two-second backoff. Network failures, HTTP 429, and HTTP 5xx are
retried. Other non-2xx responses fail immediately; redirects are never followed.
Destinations run independently. A failed delivery emits a sanitized warning with
the destination index; URLs, tokens, and signatures are not logged.
Delivery is best effort. There is no durable outbox or replay after a process
restart. Docker/host outages cannot be reported by a Dockge process on that host.
