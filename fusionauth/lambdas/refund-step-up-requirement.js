// RefundBot — MFA Requirement lambda (Tenant). Type: MFARequirement.
//
// A refund confirmation is a step-up that is ALWAYS challenged. The app calls
// /api/two-factor/status with action=stepUp and eventInfo.data.action = "refund:confirm:<id>".
// FusionAuth's default for stepUp is already "challenge"; this makes the rule explicit, so a
// later default or trust policy change can't quietly turn a refund confirmation into one click.
// If the customer has no enrolled method, the app enrolls-and-verifies their email instead
// (see /api/two-factor/status).
function checkRequired(result, user, registration, context) {
  var data = (context.eventInfo && context.eventInfo.data) || {};
  var action = String(data.action || '');
  if (context.action === 'stepUp' && action.indexOf('refund:confirm:') === 0) {
    result.required = true;
  }
}
