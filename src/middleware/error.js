import { AppError } from '../utils/errors.js';

export const notFound = (_req, res) =>
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy API' } });

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'JSON không hợp lệ' } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Lỗi máy chủ' } });
}
