import { AppError } from '../utils/errors.js';

export const validate = (schema) => (req, _res, next) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return next(
      new AppError(400, 'Dữ liệu không hợp lệ', 'VALIDATION_ERROR', parsed.error.flatten().fieldErrors),
    );
  }
  req.body = parsed.data;
  next();
};
