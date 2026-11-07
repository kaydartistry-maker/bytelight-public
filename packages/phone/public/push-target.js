// Where a tapped push should land. Loaded into sw.js with importScripts;
// kept free of worker APIs so the unit tests can run it as-is.
//
// The backend's payload is { title, body, threadId?, url?, tag? }. A reply's
// tag is `msg-<messageId>`, so that's where the message id comes from.

(function (root) {
  function str(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  /** { threadId, messageId } from a push payload (or a notification's data). */
  function pushTarget(data) {
    var d = data && typeof data === 'object' ? data : {};
    var threadId = str(d.threadId);
    if (!threadId) return { threadId: null, messageId: null };
    var messageId = str(d.messageId);
    if (!messageId) {
      var tag = str(d.tag);
      var m = tag && /^msg-(.+)$/.exec(tag);
      messageId = m ? m[1] : null;
    }
    return { threadId: threadId, messageId: messageId };
  }

  /** The app URL (inside `scope`) that opens the target on a cold start. */
  function pushTargetUrl(scope, target) {
    var url = new URL(scope);
    if (target && target.threadId) {
      url.searchParams.set('thread', target.threadId);
      if (target.messageId) url.searchParams.set('message', target.messageId);
    }
    return url.href;
  }

  root.bytelightPushTarget = { pushTarget: pushTarget, pushTargetUrl: pushTargetUrl };
})(self);
