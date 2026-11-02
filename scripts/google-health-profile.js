// Paste this function into the custom OAuth2 connection's profile script.
function fetchUserProfile(accessToken, ctx, cb) {
  request.get({
    url: 'https://health.googleapis.com/v4/users/me/identity',
    headers: { Authorization: 'Bearer ' + accessToken },
    json: true,
    timeout: 10000
  }, function (err, response, body) {
    if (err || !response || response.statusCode !== 200 || !body || !body.healthUserId) {
      return cb(new Error('Google Health profile unavailable. Finish linking the personal Google account in the Google Health mobile app and check API permissions.'));
    }
    // Keep the provider identifier in Auth0, outside model messages.
    cb(null, { user_id: String(body.healthUserId) });
  });
}
