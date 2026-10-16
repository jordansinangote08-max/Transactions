// Run once inside Scriptable on your iPhone. Never publish the generated value.
// Two independent random UUIDs provide a long, unguessable, widget-only token.
const token = UUID.string().replace(/-/g, '') + UUID.string().replace(/-/g, '');
Pasteboard.copyString(token);
const notice = new Alert();
notice.title = 'Widget token copied';
notice.message = 'Paste it into WIDGET_READ_TOKEN in your Apps Script Script Properties, then into the widget’s secure setup prompt. Keep it in your password manager. It is not printed or saved in this script.';
notice.addAction('OK');
await notice.presentAlert();
Script.complete();
