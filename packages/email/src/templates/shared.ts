export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function emailShell(preheader: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Skillplane</title>
  </head>
  <body style="margin:0;background:#f5f5f7;color:#17171a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5f7;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;border:1px solid #dedee3;border-radius:12px;background:#ffffff">
            <tr>
              <td style="padding:28px 32px 18px;border-bottom:1px solid #ececef;font-size:16px;font-weight:700">Skillplane</td>
            </tr>
            <tr>
              <td style="padding:32px">${content}</td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid #ececef;color:#6d6d76;font-size:12px;line-height:1.6">This security message was sent by Skillplane.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
