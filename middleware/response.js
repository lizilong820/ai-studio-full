// 统一响应格式
function responseWrapper(req, res, next) {
  res.success = function(data = {}, msg = 'success') {
    res.json({ code: 0, msg, data });
  };
  
  res.error = function(msg = 'error', code = 1, data = {}) {
    res.json({ code, msg, data });
  };
  
  next();
}

module.exports = responseWrapper;
