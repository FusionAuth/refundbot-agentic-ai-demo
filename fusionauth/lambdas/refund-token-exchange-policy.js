// RefundBot — Token Exchange Policy lambda (Tenant, policy engine = LAMBDA). Type: TokenExchangePolicy.
//
// Installed by scripts/install-fusionauth-lambdas.mjs, which fills in the __PLACEHOLDERS__.
//
// Switching the Tenant from the ENTITY engine to LAMBDA would normally drop the Entity
// Grant check. This policy keeps it as rule 5, asking FusionAuth whether the Grant from the
// orchestrator to the target service exists right now, so the on-demand banking-api
// Grant (lib/entities.ts) still gates hop 4. Rules 1-4 are what Grants alone can't say:
//
//   1. only the RefundBot orchestrator Entity may exchange on this Tenant;
//   2. exactly one audience per exchange, and it must be a RefundBot service;
//   3. the subject token is this Tenant's own access token, and NOT an exchanged one
//      (no `act`) — every hop must exchange the customer's ORIGINAL token;
//   4. the subject token was issued to a RefundBot front door: the web app or the
//      MCP connector that ChatGPT / claude.ai log in to.
//
// Then: banking-api tokens live 60 seconds; the read-only hops get 300.
// Every denial reaches the trace verbatim (error_reason: lambda_denied).

var ORCHESTRATOR = '__ORCHESTRATOR_ID__';
var SERVICES = {
  '__ORDER_HISTORY_ID__': { name: 'order-history', ttl: 300 },
  '__SCORING_ID__': { name: 'customer-scoring', ttl: 300 },
  '__BUDGET_ID__': { name: 'refund-budget', ttl: 300 },
  '__BANKING_ID__': { name: 'banking-api', ttl: 60 }
};
var FRONT_DOORS = ['__APP_CLIENT_ID__', '__CONNECTOR_RESOURCE_URL__'];
var FUSIONAUTH_URL = '__FUSIONAUTH_URL__';

function policy(result, exchange, context) {
  if (exchange.clientId !== ORCHESTRATOR) {
    return deny(result, 'unauthorized_client',
      'RefundBot policy: only the RefundBot orchestrator may exchange tokens on this tenant.');
  }

  var requested = exchange.requestedAudiencesAndResources || [];
  if (requested.length !== 1) {
    return deny(result, 'invalid_target',
      'RefundBot policy: exactly one service audience per exchange (got ' + requested.length + ').');
  }
  var target = requested[0];
  var service = SERVICES[target];
  if (!service) {
    return deny(result, 'invalid_target',
      'RefundBot policy: ' + target + ' is not a RefundBot service.');
  }

  var claims = exchange.subjectTokenClaims || {};
  if (exchange.subjectTokenValidationStatus !== 'AUTHORITATIVE') {
    return deny(result, 'invalid_request',
      'RefundBot policy: the subject token must be an access token this tenant issued.');
  }
  if (claims.act) {
    return deny(result, 'invalid_request',
      'RefundBot policy: the subject token is already an exchanged token. Exchange the ' +
      "customer's original access token, never a previous hop's.");
  }
  var aud = [].concat(claims.aud || []);
  var fromFrontDoor = aud.some(function (a) { return FRONT_DOORS.indexOf(a) !== -1; });
  if (!fromFrontDoor) {
    return deny(result, 'unauthorized_client',
      'RefundBot policy: the subject token was not issued to a RefundBot front door ' +
      '(web app or MCP connector); aud=' + aud.join(','));
  }

  var apiKey = context.services.secrets.get('refundbot-grant-reader');
  if (!apiKey) {
    return deny(result, 'invalid_request',
      'RefundBot policy: the refundbot-grant-reader secret is missing, so the Entity Grant cannot be checked.');
  }
  var response = fetch(FUSIONAUTH_URL + '/api/entity/grant/search?entityId=' +
    encodeURIComponent(target) + '&recipientEntityId=' + encodeURIComponent(ORCHESTRATOR), {
    method: 'GET',
    headers: { 'Authorization': apiKey, 'X-FusionAuth-TenantId': context.tenantId }
  });
  if (response.status !== 200) {
    console.error('Entity Grant search returned status ' + response.status + '.');
    return deny(result, 'invalid_request',
      'RefundBot policy: could not check the Entity Grant for ' + service.name +
      ' (status ' + response.status + ').');
  }
  var body = JSON.parse(response.body || '{}');
  var grants = body.grants || [];
  if (grants.length === 0) {
    return deny(result, 'unauthorized_client',
      'RefundBot policy: no Entity Grant from the orchestrator to ' + service.name + ' exists right now.');
  }

  result.decision = 'ALLOW';
  result.granted = { aud: [target], scope: [], expires_in: service.ttl };
}

function deny(result, code, description) {
  result.decision = 'DENY';
  result.denial = { error_code: code, error_description: description };
}
