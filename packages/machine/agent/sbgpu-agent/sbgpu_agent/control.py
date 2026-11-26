"""The agent's client for the control plane's /v1/agent/* endpoints (@sbgpu/api routes.ts): JSON over https only,
bounded responses, explicit timeouts.  The transport is injectable so tests run without a network."""

import json
import urllib.error
import urllib.request

RESPONSE_MAX = 1024 * 1024  # bytes of any control-plane answer
TIMEOUT_S = 20


class ControlError(Exception):
    """A refused or failed call.  `status` is the HTTP status, or None for a network or format failure."""

    def __init__(self, status, message):
        Exception.__init__(self, message)
        self.status = status

    @property
    def refused(self):
        """401 or 403: this machine's token or boot token is no good; the agent stops for good (exit 3)."""
        return self.status in (401, 403)


class _HttpsOnly(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(newurl, code, "the control plane doesn't redirect", headers, fp)


def https_transport(method, url, headers, body, timeout):
    """(status, body bytes) for one request; https only, no redirects followed."""
    if not url.startswith("https://"):
        raise ControlError(None, "the control URL must be https")
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.build_opener(_HttpsOnly).open(req, timeout=timeout) as r:
            return r.status, r.read(RESPONSE_MAX + 1)
    except urllib.error.HTTPError as e:
        return e.code, e.read(RESPONSE_MAX + 1) if e.fp else b""
    except (urllib.error.URLError, OSError) as e:
        raise ControlError(None, "network: %s" % type(e).__name__)


class Control:
    def __init__(self, base_url, transport=https_transport):
        self.base = base_url.rstrip("/")
        self.transport = transport
        self.token = None  # the agent token, once enrolled

    def post(self, path, payload, auth=True, timeout=TIMEOUT_S):
        headers = {"content-type": "application/json", "accept": "application/json"}
        if auth:
            if not self.token:
                raise ControlError(None, "no agent token")
            headers["authorization"] = "Bearer " + self.token
        body = json.dumps(payload, separators=(",", ":")).encode()
        status, data = self.transport("POST", self.base + path, headers, body, timeout)
        if len(data) > RESPONSE_MAX:
            raise ControlError(status, "response too large")
        try:
            parsed = json.loads(data.decode("utf-8")) if data else {}
        except ValueError:
            raise ControlError(status, "response isn't JSON")
        if not 200 <= status < 300:
            err = parsed.get("error") if isinstance(parsed, dict) else None
            code = err.get("code") if isinstance(err, dict) else None
            raise ControlError(status, "HTTP %d %s" % (status, code if isinstance(code, str) else ""))
        if not isinstance(parsed, dict):
            raise ControlError(status, "response isn't an object")
        return parsed

    def enroll(self, request, timeout=TIMEOUT_S):
        r = self.post("/v1/agent/enroll", request, auth=False, timeout=timeout)
        token = r.get("agentToken")
        if not isinstance(token, str) or not token:
            raise ControlError(None, "enroll gave no agent token")
        self.token = token
        return r

    def abort(self, boot_token, reason):
        return self.post("/v1/agent/abort", {"bootToken": boot_token, "reason": reason}, auth=False)

    def heartbeat(self, request):
        r = self.post("/v1/agent/heartbeat", request)
        token = r.get("agentToken")
        if isinstance(token, str) and token:
            self.token = token
        commands = r.get("commands", [])
        if not isinstance(commands, list):
            raise ControlError(None, "heartbeat commands isn't a list")
        return [c for c in commands if isinstance(c, dict) and isinstance(c.get("id"), str) and isinstance(c.get("op"), str)]

    def save_status(self, request):
        return self.post("/v1/agent/save-status", request)
