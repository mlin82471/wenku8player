//! 本地 HTTP 服务
//!
//! 用 axum 复刻原 server.js 的职责：
//!   1. 托管 public/ 静态资源（保留 Range 支持，视频背景可拖动）
//!   2. 提供 /audio-proxy 同源音频代理（Web Audio 才能分析真实频谱，防盗链绕过）
//!   3. 直接实现前端用到的网易云、哔哩哔哩音频、QQ音乐接口
//!   4. 提供桌面悬浮灵动岛控制接口 (/api/island/*)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use tower_http::services::ServeDir;

use crate::ncm::NcmClient;

pub struct ServerState {
    pub ncm: NcmClient,
    pub http: reqwest::Client,
    pub app_handle: Option<tauri::AppHandle>,
}

type AppState = Arc<ServerState>;

/// 启动本地服务，返回实际绑定的端口
pub fn start(public: PathBuf, app_handle: Option<tauri::AppHandle>) -> std::io::Result<u16> {
    let (tx, rx) = std::sync::mpsc::channel::<u16>();

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[wenku8] 创建异步运行时失败: {}", e);
                return;
            }
        };

        rt.block_on(async move {
            let candidate_ports = [62983, 49816, 0];
            let mut bound_listener = None;
            for p in candidate_ports {
                if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", p)).await {
                    bound_listener = Some(l);
                    break;
                }
            }

            let listener = match bound_listener {
                Some(l) => l,
                None => {
                    eprintln!("[wenku8] 端口绑定失败: 所有候选端口与动态端口均不可用");
                    return;
                }
            };
            let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
            let _ = tx.send(port);

            println!("[wenku8] 静态目录: {}", public.display());
            println!("[wenku8] 本地服务: http://127.0.0.1:{}", port);

            let state: AppState = Arc::new(ServerState {
                ncm: NcmClient::new(),
                http: reqwest::Client::builder()
                    .gzip(true)
                    .danger_accept_invalid_certs(true)
                    .timeout(std::time::Duration::from_secs(25))
                    .build()
                    .unwrap_or_default(),
                app_handle,
            });

            if let Err(e) = axum::serve(listener, router(public, state)).await {
                eprintln!("[wenku8] 服务异常退出: {}", e);
            }
        });
    });

    rx.recv()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

fn router(public: PathBuf, state: AppState) -> Router {
    Router::new()
        .route("/audio-proxy", get(audio_proxy))
        .route("/cover-proxy", get(cover_proxy))
        // 网易云登录
        .route("/login/qr/key", get(h_qr_key))
        .route("/login/qr/create", get(h_qr_create))
        .route("/login/qr/check", get(h_qr_check))
        // 网易云账号 / 歌单
        .route("/user/account", get(h_user_account))
        .route("/user/playlist", get(h_user_playlist))
        .route("/playlist/detail", get(h_playlist_detail))
        .route("/playlist/track/all", get(h_playlist_track_all))
        .route("/recommend/songs", get(h_recommend_songs))
        // 网易云搜索 / 播放 / 歌词 / 评论 / 红心
        .route("/cloudsearch", get(h_cloudsearch))
        .route("/search", get(h_cloudsearch))
        .route("/song/url", get(h_song_url))
        .route("/song/url/v1", get(h_song_url_v1))
        .route("/lyric", get(h_lyric))
        .route("/comment/music", get(h_comment_music))
        .route("/like", get(h_like))
        // 哔哩哔哩音频
        .route("/bili/qr/generate", get(h_bili_qr_generate))
        .route("/bili/qr/poll", get(h_bili_qr_poll))
        .route("/bili/user/info", get(h_bili_user_info))
        .route("/bili/fav/folders", get(h_bili_fav_folders))
        .route("/bili/fav/resources", get(h_bili_fav_resources))
        .route("/bili/audio/url", get(h_bili_audio_url))
        // QQ 音乐
        .route("/qq/playlist", get(h_qq_playlist))
        .route("/qq/toplist", get(h_qq_toplist))
        // 桌面灵动岛控制
        .route("/api/island/action", get(h_island_action))
        .route("/api/island/settings", get(h_island_settings))
        .fallback_service(ServeDir::new(&public))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

fn cookie_of(headers: &HeaderMap, q: &HashMap<String, String>) -> String {
    if let Some(cookie) = headers.get("X-Ncm-Cookie").and_then(|h| h.to_str().ok()) {
        if !cookie.is_empty() {
            return cookie.to_string();
        }
    }
    if let Some(cookie) = headers.get(header::COOKIE).and_then(|h| h.to_str().ok()) {
        if !cookie.is_empty() {
            return cookie.to_string();
        }
    }
    q.get("cookie").cloned().unwrap_or_default()
}

fn reply(result: Result<Value, String>) -> Response {
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            eprintln!("[wenku8] 接口错误: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "code": 502, "message": e })),
            )
                .into_response()
        }
    }
}

fn generate_qr_b64(content: &str) -> String {
    match qrcode::QrCode::new(content.as_bytes()) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(200, 200)
                .build();
            use base64::Engine as _;
            let b64 = base64::engine::general_purpose::STANDARD.encode(svg.as_bytes());
            format!("data:image/svg+xml;base64,{}", b64)
        }
        Err(e) => {
            eprintln!("[bili] 二维码生成失败: {}", e);
            String::new()
        }
    }
}

// ---------------------------------------------------------------------------
// 网易云接口处理器
// ---------------------------------------------------------------------------

async fn h_qr_key(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    reply(s.ncm.qr_key(&cookie_of(&headers, &q)).await)
}

async fn h_qr_create(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let key = q.get("key").cloned().unwrap_or_default();
    let with_img = q.get("qrimg").map(|v| v != "false").unwrap_or(false);
    reply(Ok(s.ncm.qr_create(&key, with_img)))
}

async fn h_qr_check(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let key = q.get("key").cloned().unwrap_or_default();
    reply(s.ncm.qr_check(&key, &cookie_of(&headers, &q)).await)
}

async fn h_user_account(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    reply(s.ncm.user_account(&cookie_of(&headers, &q)).await)
}

async fn h_user_playlist(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.user_playlist(&cookie, &q).await)
}

async fn h_playlist_detail(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.playlist_detail(&cookie, &q).await)
}

async fn h_playlist_track_all(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.playlist_track_all(&cookie, &q).await)
}

async fn h_recommend_songs(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    reply(s.ncm.recommend_songs(&cookie_of(&headers, &q)).await)
}

async fn h_cloudsearch(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.cloudsearch(&cookie, &q).await)
}

async fn h_song_url(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.song_url(&cookie, &q).await)
}

async fn h_song_url_v1(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.song_url_v1(&cookie, &q).await)
}

async fn h_lyric(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.lyric(&cookie, &q).await)
}

async fn h_comment_music(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.comment_music(&cookie, &q).await)
}

async fn h_like(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    reply(s.ncm.like(&cookie, &q).await)
}

// ---------------------------------------------------------------------------
// 哔哩哔哩音频接口处理器
// ---------------------------------------------------------------------------

async fn h_bili_qr_generate(State(s): State<AppState>) -> Response {
    let url = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
    let resp = match s.http.get(url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header(header::REFERER, "https://passport.bilibili.com/")
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("请求B站二维码失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站二维码响应失败: {}", e))),
    };
    if let Some(data) = json_val.get("data") {
        let qr_url = data.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let qrcode_key = data.get("qrcode_key").and_then(|k| k.as_str()).unwrap_or("");
        let qrimg = generate_qr_b64(qr_url);
        return reply(Ok(json!({
            "code": 0,
            "url": qr_url,
            "qrcode_key": qrcode_key,
            "qrimg": qrimg
        })));
    }
    reply(Ok(json_val))
}

async fn h_bili_qr_poll(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let key = q.get("qrcode_key").cloned().unwrap_or_default();
    let url = format!("https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={}", key);
    let resp = match s.http.get(&url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .header(header::REFERER, "https://passport.bilibili.com/")
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("轮询B站扫码失败: {}", e))),
        };

    let mut cookies = Vec::new();
    for (k, v) in resp.headers().iter() {
        if k == header::SET_COOKIE {
            if let Ok(s_val) = v.to_str() {
                if let Some(cookie_pair) = s_val.split(';').next() {
                    cookies.push(cookie_pair.trim().to_string());
                }
            }
        }
    }
    let cookie_str = cookies.join("; ");

    let mut json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站轮询响应失败: {}", e))),
    };

    if !cookie_str.is_empty() {
        json_val["cookie"] = json!(cookie_str);
    }
    reply(Ok(json_val))
}

async fn h_bili_user_info(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    let url = "https://api.bilibili.com/x/web-interface/nav";
    let resp = match s.http.get(url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://www.bilibili.com/")
        .header(header::COOKIE, &cookie)
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("拉取B站用户信息失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站用户信息失败: {}", e))),
    };
    reply(Ok(json_val))
}

async fn h_bili_fav_folders(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    let mid = q.get("mid").cloned().unwrap_or_default();
    let url = format!("https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={}", mid);
    let resp = match s.http.get(&url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://www.bilibili.com/")
        .header(header::COOKIE, &cookie)
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("获取B站收藏夹失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站收藏夹失败: {}", e))),
    };
    reply(Ok(json_val))
}

async fn h_bili_fav_resources(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    let media_id = q.get("media_id").cloned().unwrap_or_default();
    let pn = q.get("pn").cloned().unwrap_or_else(|| "1".to_string());
    let ps = q.get("ps").cloned().unwrap_or_else(|| "25".to_string());
    let url = format!("https://api.bilibili.com/x/v3/fav/resource/list?media_id={}&pn={}&ps={}", media_id, pn, ps);
    let resp = match s.http.get(&url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://www.bilibili.com/")
        .header(header::COOKIE, &cookie)
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("获取B站收藏资源失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站资源失败: {}", e))),
    };
    reply(Ok(json_val))
}

async fn h_bili_audio_url(State(s): State<AppState>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let cookie = cookie_of(&headers, &q);
    let bvid = q.get("bvid").cloned().unwrap_or_default();
    let mut cid = q.get("cid").cloned().unwrap_or_default();

    if cid.is_empty() && !bvid.is_empty() {
        // 先查 view 获取 cid
        let view_url = format!("https://api.bilibili.com/x/web-interface/view?bvid={}", bvid);
        if let Ok(resp) = s.http.get(&view_url)
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header(header::REFERER, "https://www.bilibili.com/")
            .header(header::COOKIE, &cookie)
            .send().await {
                if let Ok(v) = resp.json::<Value>().await {
                    if let Some(c) = v.pointer("/data/cid").and_then(|c| c.as_i64()) {
                        cid = c.to_string();
                    } else if let Some(c) = v.pointer("/data/pages/0/cid").and_then(|c| c.as_i64()) {
                        cid = c.to_string();
                    }
                }
            }
    }

    if cid.is_empty() {
        return reply(Err("未获取到视频的 cid".to_string()));
    }

    let play_url = format!("https://api.bilibili.com/x/player/playurl?bvid={}&cid={}&fnval=16", bvid, cid);
    let resp = match s.http.get(&play_url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://www.bilibili.com/")
        .header(header::COOKIE, &cookie)
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("获取B站播放地址失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析B站播放地址失败: {}", e))),
    };

    let audio_url = json_val.pointer("/data/dash/audio/0/baseUrl")
        .and_then(|u| u.as_str())
        .or_else(|| json_val.pointer("/data/dash/audio/0/backupUrl/0").and_then(|u| u.as_str()))
        .or_else(|| json_val.pointer("/data/durl/0/url").and_then(|u| u.as_str()))
        .unwrap_or("");

    if audio_url.is_empty() {
        return reply(Err("未找到可用音频流".to_string()));
    }

    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let proxy_url = format!("/audio-proxy?url={}", utf8_percent_encode(audio_url, NON_ALPHANUMERIC));
    reply(Ok(json!({
        "code": 0,
        "audioUrl": proxy_url,
        "rawUrl": audio_url
    })))
}

// ---------------------------------------------------------------------------
// QQ 音乐接口处理器
// ---------------------------------------------------------------------------

fn extract_disstid(raw: &str) -> String {
    if let Some(pos) = raw.find("id=").or_else(|| raw.find("disstid=")) {
        let after = &raw[pos..];
        if let Some(eq_pos) = after.find('=') {
            let digits: String = after[eq_pos + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if digits.len() >= 5 {
                return digits;
            }
        }
    }
    let mut best = String::new();
    let mut cur = String::new();
    for c in raw.chars() {
        if c.is_ascii_digit() {
            cur.push(c);
        } else {
            if cur.len() >= 6 && cur.len() <= 14 && cur.len() > best.len() {
                best = cur.clone();
            }
            cur.clear();
        }
    }
    if cur.len() >= 6 && cur.len() <= 14 && cur.len() > best.len() {
        best = cur;
    }
    if !best.is_empty() {
        best
    } else {
        raw.to_string()
    }
}

async fn h_qq_playlist(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let mut disstid = q.get("id").cloned().unwrap_or_default().trim().to_string();

    // 如果传入的是 URL 或包含非纯数字字符，智能提取
    if disstid.starts_with("http") || !disstid.chars().all(|c| c.is_ascii_digit()) {
        if disstid.contains("c6.y.qq.com") || disstid.contains("/fcgi-bin/u") {
            if let Ok(resp) = s.http.get(&disstid)
                .header(header::USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15")
                .send().await {
                let final_url = resp.url().as_str().to_string();
                let extracted = extract_disstid(&final_url);
                if extracted.chars().all(|c| c.is_ascii_digit()) && extracted.len() >= 5 {
                    disstid = extracted;
                }
            }
        }
        if !disstid.chars().all(|c| c.is_ascii_digit()) {
            disstid = extract_disstid(&disstid);
        }
    }

    let url = format!(
        "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid={}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0",
        disstid
    );
    let resp = match s.http.get(&url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://y.qq.com/")
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("获取QQ音乐歌单失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析QQ音乐歌单失败: {}", e))),
    };
    reply(Ok(json_val))
}

async fn h_qq_toplist(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let topid = q.get("topid").cloned().unwrap_or_else(|| "26".to_string());
    let url = format!(
        "https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid={}&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0",
        topid
    );
    let resp = match s.http.get(&url)
        .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .header(header::REFERER, "https://y.qq.com/")
        .send().await {
            Ok(r) => r,
            Err(e) => return reply(Err(format!("获取QQ音乐榜单失败: {}", e))),
        };
    let json_val: Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return reply(Err(format!("解析QQ音乐榜单失败: {}", e))),
    };
    reply(Ok(json_val))
}

// ---------------------------------------------------------------------------
// 桌面灵动岛控制接口处理器
// ---------------------------------------------------------------------------

async fn h_island_action(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let cmd = q.get("cmd").map(|s| s.as_str()).unwrap_or("");
    if let Some(app) = &s.app_handle {
        use tauri::Manager;
        match cmd {
            "show_main" => {
                if let Some(main) = app.get_webview_window("main") {
                    let _ = main.show();
                    let _ = main.unminimize();
                    let _ = main.set_focus();
                }
                if let Some(island) = app.get_webview_window("island") {
                    let _ = island.hide();
                }
            }
            "show_island" => {
                if let Some(island) = app.get_webview_window("island") {
                    let _ = island.show();
                    let _ = island.set_always_on_top(crate::ISLAND_ALWAYS_ON_TOP.load(std::sync::atomic::Ordering::SeqCst));
                    let _ = island.unminimize();
                }
            }
            "expand" => {
                let expanded = q.get("expanded").map(|v| v == "1" || v == "true").unwrap_or(false);
                let playing = q.get("playing").map(|v| v == "1" || v == "true").unwrap_or(false);
                if let Some(island) = app.get_webview_window("island") {
                    let (w, h) = if expanded {
                        (284.0, 74.0)
                    } else if playing {
                        (186.0, 28.0)
                    } else {
                        (120.0, 28.0)
                    };
                    let _ = island.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                    if let Ok(Some(monitor)) = island.primary_monitor() {
                        let scale = monitor.scale_factor();
                        let screen_w = monitor.size().width as f64 / scale;
                        let x = (screen_w - w) / 2.0;
                        let _ = island.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, 4.0)));
                    }
                }
            }
            "hide_island" => {
                if let Some(island) = app.get_webview_window("island") {
                    let _ = island.hide();
                }
            }
            "toggle_island" => {
                if let Some(island) = app.get_webview_window("island") {
                    let is_vis = island.is_visible().unwrap_or(false);
                    if is_vis {
                        let _ = island.hide();
                    } else {
                        let _ = island.show();
                        let _ = island.unminimize();
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.hide();
                        }
                    }
                }
            }
            _ => {}
        }
    }
    reply(Ok(json!({ "code": 0, "ok": true })))
}

async fn h_island_settings(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let enable = q.get("enable").map(|v| v != "false").unwrap_or(true);
    let always_on_top = q.get("always_on_top").map(|v| v != "false").unwrap_or(true);
    crate::update_island_config(enable, always_on_top);
    if let Some(app) = &s.app_handle {
        use tauri::Manager;
        if let Some(island) = app.get_webview_window("island") {
            let _ = island.set_always_on_top(always_on_top);
            if !enable {
                let _ = island.hide();
            }
        }
    }
    reply(Ok(json!({ "code": 0, "ok": true })))
}

// ---------------------------------------------------------------------------
// 音频同源代理 & 封面同源代理
// ---------------------------------------------------------------------------

fn host_allowed(host: &str) -> bool {
    let h = host.to_ascii_lowercase();
    const SUFFIXES: &[&str] = &[
        "music.126.net",
        "music.163.com",
        "126.net",
        "163.com",
        "127.net",
        "netease.com",
        "ydstatic.com",
        "bilibili.com",
        "bilivideo.com",
        "bilivideo.cn",
        "hdslb.com",
        "biliapi.net",
        "biliapi.com",
        "bilibili.tv",
        "akamaized.net",
        "qq.com",
        "gtimg.cn",
        "gtimg.com",
        "qpic.cn",
        "tencent.com",
        "qqmusic.qq.com",
    ];
    SUFFIXES
        .iter()
        .any(|s| h == *s || h.ends_with(&format!(".{}", s)))
}

async fn audio_proxy(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let raw = match q.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return (StatusCode::BAD_REQUEST, "missing url").into_response(),
    };

    let parsed = match url::Url::parse(&raw) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad url").into_response(),
    };

    if !matches!(parsed.scheme(), "http" | "https") {
        return (StatusCode::BAD_REQUEST, "bad protocol").into_response();
    }
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if !host_allowed(&host) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }

    let build_req = |url_str: &str| {
        let mut r = s.http.get(url_str);
        if let Some(range) = headers.get(header::RANGE) {
            r = r.header(header::RANGE, range);
        }
        if host.contains("bilibili") || host.contains("bilivideo") || host.contains("hdslb") {
            r = r
                .header(header::REFERER, "https://www.bilibili.com/")
                .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        } else if host.contains("qq.com") || host.contains("gtimg") || host.contains("qpic") {
            r = r
                .header(header::REFERER, "https://y.qq.com/")
                .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        } else if host.contains("163.com") || host.contains("126.net") {
            r = r
                .header(header::REFERER, "https://music.163.com/")
                .header("X-Real-IP", "116.25.146.177")
                .header("X-Forwarded-For", "116.25.146.177")
                .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        }
        r
    };

    let mut upstream = build_req(parsed.as_str()).send().await;

    // 智能协议自愈：如果因 TLS 握手/网络异常失败且原为 https，自动切回 http 重试
    if upstream.is_err() && parsed.scheme() == "https" {
        let mut fallback = parsed.clone();
        if fallback.set_scheme("http").is_ok() {
            eprintln!("[wenku8] HTTPS 握手失败，自动切至 HTTP 节点重试: {}", fallback.as_str());
            upstream = build_req(fallback.as_str()).send().await;
        }
    }

    let upstream = match upstream {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[wenku8] 音频代理彻底失败: {}", e);
            return (StatusCode::BAD_GATEWAY, "").into_response();
        }
    };

    let status = upstream.status();
    let mut builder = Response::builder().status(status.as_u16());

    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::ETAG,
        header::LAST_MODIFIED,
    ] {
        if let Some(v) = upstream.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }
    builder = builder.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");

    let stream = upstream.bytes_stream();
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "").into_response())
}

async fn cover_proxy(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let raw = match q.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => return (StatusCode::BAD_REQUEST, "missing url").into_response(),
    };

    let parsed = match url::Url::parse(&raw) {
        Ok(u) => u,
        Err(_) => return (StatusCode::BAD_REQUEST, "bad url").into_response(),
    };

    if !matches!(parsed.scheme(), "http" | "https") {
        return (StatusCode::BAD_REQUEST, "bad protocol").into_response();
    }
    let host = parsed.host_str().unwrap_or("");
    if !host_allowed(host) {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }

    let mut req = s.http.get(parsed.as_str());
    if host.contains("bilibili.com") || host.contains("hdslb.com") {
        req = req
            .header(header::REFERER, "https://www.bilibili.com/")
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    } else if host.contains("qq.com") || host.contains("gtimg.cn") || host.contains("qpic.cn") {
        req = req
            .header(header::REFERER, "https://y.qq.com/")
            .header(header::USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[wenku8] 封面代理失败: {}", e);
            return (StatusCode::BAD_GATEWAY, "").into_response();
        }
    };

    let status = upstream.status();
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("image/jpeg"));

    let stream = upstream.bytes_stream();
    Response::builder()
        .status(status.as_u16())
        .header(header::CONTENT_TYPE, content_type)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "").into_response())
}
