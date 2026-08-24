use axum::{
    extract::Request,
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::Utc;
use serde::Serialize;
use tower_http::request_id::RequestId;
use tracing::span;

use crate::response::ApiErrorCode::PoolError;

#[derive(Serialize)]
pub struct RequestMeta {
    pub request_id: String,
    pub timestamp: String,
}

impl RequestMeta {
    pub fn new(request_id: RequestId) -> Self {
        let timestamp = Utc::now();

        RequestMeta {
            request_id: req_id_to_string(request_id),
            timestamp: timestamp.to_string(),
        }
    }
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum ApiResponse<T: Serialize> {
    Success {
        success: bool,
        data: T,
        meta: RequestMeta,
    },

    Error {
        success: bool,
        error: ApiError,
        meta: RequestMeta,
    },
}

impl<T: Serialize> ApiResponse<T> {
    pub fn success(data: T, req_id: RequestId) -> ApiResponse<T> {
        Self::Success {
            success: true,
            data,
            meta: RequestMeta::new(req_id),
        }
    }
    pub fn error(error: ApiError, req_id: RequestId) -> ApiResponse<T> {
        Self::Error {
            success: false,
            error,
            meta: RequestMeta::new(req_id),
        }
    }
}

impl<T: Serialize> IntoResponse for ApiResponse<T> {
    fn into_response(self) -> Response {
        let status = match &self {
            ApiResponse::Success { .. } => StatusCode::OK,
            ApiResponse::Error { error, .. } => get_status_code_for_error(&error.code),
        };
        (status, Json(self)).into_response()
    }
}

#[derive(Serialize)]
pub struct ApiError {
    pub code: ApiErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<ErrorDetail>,
}

impl ApiError {
    pub fn new(code: ApiErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: None,
        }
    }

    pub fn with_field(mut self, field: impl Into<String>, reason: impl Into<String>) -> Self {
        self.details = Some(ErrorDetail {
            field: field.into(),
            reason: reason.into(),
        });
        self
    }
}

#[derive(Serialize)]
struct ErrorDetail {
    pub field: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ApiErrorCode {
    ValidationError,
    DbError,
    ValueNotFound,
    InvalidInput,
    DuplicateValue,
    BadGateway,
    Unauthorized,
    PoolDoesNotExists,
    PoolError,
}

pub fn get_status_code_for_error(code: &ApiErrorCode) -> StatusCode {
    match code {
        ApiErrorCode::ValidationError => StatusCode::UNPROCESSABLE_ENTITY, // 422
        ApiErrorCode::InvalidInput => StatusCode::BAD_REQUEST,             // 400
        ApiErrorCode::ValueNotFound | ApiErrorCode::PoolDoesNotExists => StatusCode::NOT_FOUND, // 404
        ApiErrorCode::DuplicateValue => StatusCode::CONFLICT, // 409
        ApiErrorCode::Unauthorized => StatusCode::UNAUTHORIZED, // 401
        ApiErrorCode::BadGateway => StatusCode::BAD_GATEWAY,  // 502
        ApiErrorCode::DbError | PoolError => StatusCode::INTERNAL_SERVER_ERROR, // 500
    }
}

pub fn req_id_to_string(req_id: RequestId) -> String {
    req_id
        .header_value()
        .to_str()
        .ok()
        .and_then(|v| Some(v.to_owned()))
        .unwrap()
}
