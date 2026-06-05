# WeChat Ticket Shortlink Design

## Context

Wechat auto-created ticket receipts currently confirm creation with ticket title, booth, issue type, and status. The user wants the receipt to include a ticket detail link, but the full URL is too long for WeChat messages.

The public URL is temporarily provided by `start-external.ps1` through a Cloudflare temporary tunnel. A fixed domain will be configured later.

## Requirements

- Creation receipts sent back to WeChat must use this text shape:

```text
现场工单已创建成功！
名称：1BT03-未知公司-综合服务
展位：1BT03
类型：综合服务
当前进度：待受理
工单详情：https://public-host/t/shortcode
```

- The link must use an internal short path, `/t/{code}`, instead of exposing the full ticket id.
- The public host must resolve in this priority order:
  1. `APP_PUBLIC_BASE_URL`, for a future fixed domain.
  2. `data/public-base-url.txt`, written by the external startup script after Cloudflare returns the temporary URL.
  3. No link appended if neither value is available.
- Opening `/t/{code}` must route users into the mobile app and auto-open the matching ticket detail after login/bootstrap data is available.
- The short code must be deterministic from the ticket id, so no database schema change is needed.

## Design

Add a small domain helper for ticket short links. It will normalize a ticket id by removing the `ticket-` prefix and non-alphanumeric separators, then use the first eight characters as the code. The same helper will create `/t/{code}` paths, build absolute URLs from a public base URL, and resolve a short code back to a ticket from loaded ticket summaries.

The WeChat watchtower service will format creation receipts with the requested labels and append `工单详情：{url}` only when a public base URL is known. Existing urge-existing receipts will keep their current wording because they are not creation receipts.

The startup script will write the Cloudflare temporary tunnel URL to `data/public-base-url.txt` after printing it. It will remove the file at startup before the new tunnel is known, so stale temporary URLs are not reused accidentally.

The mobile page will read `ticketId` or `ticketCode` from the URL. `/t/{code}` will redirect to `/?ticketCode={code}`. Once bootstrap data loads, the page will select the matching ticket and fetch full detail through the existing `/api/tickets/{ticketId}` endpoint.

## Testing

- Unit test the short-link helper for stable code, path, URL, and code resolution behavior.
- Add a WeChat watchtower service test proving creation receipts use the requested text shape and include `/t/{code}`.
- Add an app navigation test proving `?ticketCode={code}` opens the ticket detail.
- Run targeted tests first, then the relevant test set.

## Self-Review

- No database migration is required because the short code is derived.
- The Cloudflare temporary URL is available to an already-running server because it is written to a file read at receipt time.
- If a public base URL is missing, the receipt remains useful and does not send an unusable localhost URL.
