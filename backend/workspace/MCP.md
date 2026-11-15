# URL-based MCP connections

Open **Plugins & memory → Add MCP server**. Enter a connection name, public HTTPS URL (usually /mcp), and no authentication or a bearer token. Connect initializes MCP and discovers tools before saving the enabled connection. View tools shows the actual schemas. Disable prevents new calls; Remove deletes that account's connection and encrypted credential.

Echo receives connection metadata plus mcp_tools and mcp_call in its capability context. It reads schemas and invokes discovered tools for the user's request. Existing in-chat receipts show the actual result. Failed or uncertain writes are not automatically retried.

## Supported behavior

- Streamable HTTP JSON-RPC; JSON or SSE responses to POST.
- Negotiated 2025-03-26, 2025-06-18 and 2025-11-25 protocol versions.
- Public HTTPS port 443, without redirects, URL credentials, fragments or query tokens.
- DNS results must all be public. The socket connects to the validated IP while TLS verifies the original hostname; there is no second hostname resolution at connect time.
- Twenty connections per account, up to 100 tools per connection, bounded arguments and responses.
- OAuth browser sign-in, legacy separate SSE endpoints, local stdio installation, private network endpoints, resource subscriptions and server-initiated sampling are not implemented by this URL flow. Existing configured owner ECHO transports are separate.

## Credentials and isolation

Connection databases live beneath the selected authenticated account root. Bearer tokens use Windows DPAPI encryption bound to the host account and account-directory entropy. Tokens are excluded from returned configuration, tool schemas, chat context and logs. Non-Windows credential persistence fails explicitly. The host administrator retains administrative access.

Remote metadata/output is untrusted. Only discovered tool names can run, and a connection ID cannot select another user's database. Logs record connection ID, tool and result status without credentials or arguments. Synthetic secret-echo and split-UTF8 regressions cover response handling.

Run python -m unittest discover -s tests -p test_remote_mcp.py. HTTP tests also check connection separation, CSRF, static serving and in-chat receipts. A live read-only check against the official Cloudflare documentation MCP server verifies discovery without sending private data or running a write tool.
