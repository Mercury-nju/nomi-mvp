// The browser worker runs on a persistent host, never inside this function.
// A missing connection must not be mistaken for an empty successful result.
export default function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(503).json({
    detail: '云端工作台尚未连接抖音执行服务；当前不能运行找客、读取私信或发送消息。',
    code: 'EXECUTION_SERVICE_NOT_CONNECTED',
  });
}
