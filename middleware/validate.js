const { body, query, param, validationResult } = require("express-validator");

// Terminal middleware: converts express-validator failures into a consistent 400.
// `error` mirrors `message` because some existing clients read `error`, others `message`.
const handle = (req, res, next) => {
    const result = validationResult(req);
    if (result.isEmpty()) return next();
    return res.status(400).json({
        success: false,
        message: "Validation failed",
        error: "Validation failed",
        errors: result.array().map(e => ({ field: e.path, message: e.msg }))
    });
};

// validate(chain1, chain2, ...) → array usable directly as route middleware.
const validate = (...chains) => [...chains.flat(), handle];

// Optional string (rejects objects/arrays/numbers, so Mongo operator objects never get through).
// Trimming/normalising is left to the Mongoose schema; length is checked on the raw value.
// Required-ness stays with the existing route/schema checks.
const str = (field, max) =>
    body(field).optional({ nullable: true })
        .isString().withMessage(`${field} must be a string`).bail()
        .isLength({ max }).withMessage(`${field} must be at most ${max} characters`);

const lat = f => f.isFloat({ min: -90, max: 90 }).withMessage("latitude must be between -90 and 90");
const lng = f => f.isFloat({ min: -180, max: 180 }).withMessage("longitude must be between -180 and 180");

// GeoJSON point: location.coordinates = [lng, lat]
const point = (field = "location") => [
    body(`${field}.coordinates`).optional()
        .isArray({ min: 2, max: 2 }).withMessage("coordinates must be [longitude, latitude]"),
    lng(body(`${field}.coordinates[0]`).optional()),
    lat(body(`${field}.coordinates[1]`).optional())
];

const pagination = [
    query("page").optional().isInt({ min: 1, max: 100000 }).withMessage("page must be a positive integer"),
    query("limit").optional().isInt({ min: 1, max: 50 }).withMessage("limit must be an integer between 1 and 50")
];

const idParam = name => param(name).isMongoId().withMessage(`${name} must be a valid id`);

module.exports = { validate, str, point, pagination, idParam, lat, lng, body, query, param };
