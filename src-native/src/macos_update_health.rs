//! Per-update health channel. No marker file can acknowledge startup. The
//! kernel-authenticated peer must run the exact expected executable, and the
//! application may not open its data until the helper grants this task.
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
type Result<T> = std::result::Result<T, String>;
const LIMIT: usize = 2048;
#[repr(C)]
struct PollFd {
    fd: i32,
    events: i16,
    revents: i16,
}

#[link(name = "proc")]
unsafe extern "C" {
    fn poll(fds: *mut PollFd, count: u32, timeout_ms: i32) -> i32;
    fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    fn proc_listpidspath(
        kind: u32,
        info: u32,
        path: *const std::ffi::c_char,
        flags: u32,
        buffer: *mut std::ffi::c_void,
        size: i32,
    ) -> i32;
}
unsafe extern "C" {
    fn geteuid() -> u32;
    fn getpeereid(fd: i32, uid: *mut u32, gid: *mut u32) -> i32;
    fn getsockopt(
        fd: i32,
        level: i32,
        name: i32,
        value: *mut std::ffi::c_void,
        len: *mut u32,
    ) -> i32;
}

pub(super) fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn private_directory(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir()
        || fs::canonicalize(path).map_err(|e| e.to_string())? != path
        || meta.uid() != unsafe { geteuid() }
        || meta.mode() & 0o077 != 0
    {
        return Err("更新健康通道需要当前用户独占的真实目录".into());
    }
    Ok(())
}

fn peer_pid(stream: &UnixStream) -> Result<u32> {
    let mut uid = 0;
    let mut gid = 0;
    let mut pid = 0i32;
    let mut size = std::mem::size_of::<i32>() as u32;
    // Darwin SDK: SOL_LOCAL=0, LOCAL_PEERPID=2. Both credentials come from
    // the socket, never from the untrusted JSON receipt.
    if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != unsafe { geteuid() }
        || unsafe {
            getsockopt(
                stream.as_raw_fd(),
                0,
                2,
                (&mut pid as *mut i32).cast(),
                &mut size,
            )
        } != 0
        || size != std::mem::size_of::<i32>() as u32
        || pid <= 0
    {
        return Err("无法确认更新健康通道的连接进程".into());
    }
    Ok(pid as u32)
}

fn process_path(pid: u32) -> Result<PathBuf> {
    let mut bytes = [0u8; 4096];
    let n = unsafe { proc_pidpath(pid as i32, bytes.as_mut_ptr().cast(), bytes.len() as u32) };
    if n <= 0 {
        return Err("无法核对更新进程路径".into());
    }
    let end = bytes
        .iter()
        .position(|b| *b == 0)
        .ok_or("更新进程路径过长")?;
    Ok(Path::new(std::ffi::OsStr::from_bytes(&bytes[..end])).to_path_buf())
}

pub(super) fn executable_in_use(path: &Path) -> Result<bool> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut pids = [0i32; 4096];
    let size = std::mem::size_of_val(&pids) as i32;
    let n = unsafe { proc_listpidspath(1, 0, path.as_ptr(), 0, pids.as_mut_ptr().cast(), size) };
    if n < 0 || n >= size {
        return Err("无法排除仍在运行的更新进程，未自动恢复".into());
    }
    Ok(n > 0)
}

fn write_frame(stream: &mut UnixStream, value: &serde_json::Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() >= LIMIT {
        return Err("更新健康消息过长".into());
    }
    bytes.push(b'\n');
    stream.write_all(&bytes).map_err(|e| e.to_string())
}
fn read_frame(stream: &mut UnixStream) -> Result<serde_json::Value> {
    read_frame_until(stream, Instant::now() + Duration::from_secs(5))
}
fn read_frame_until(stream: &mut UnixStream, deadline: Instant) -> Result<serde_json::Value> {
    // A byte-at-a-time bounded read avoids buffering and losing the next phase.
    let mut bytes = Vec::new();
    let mut byte = [0];
    for _ in 0..LIMIT {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("更新健康消息超时".into());
        }
        // Darwin may reject SO_RCVTIMEO once the peer has closed, even when
        // its final frame is still queued. Poll the absolute deadline instead.
        let mut fd = PollFd {
            fd: stream.as_raw_fd(),
            events: 1,
            revents: 0,
        };
        let milliseconds = remaining
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let ready = unsafe { poll(&mut fd, 1, milliseconds) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.to_string());
        }
        if ready == 0 {
            return Err("更新健康消息超时".into());
        }
        stream.read_exact(&mut byte).map_err(|e| e.to_string())?;
        if byte[0] == b'\n' {
            return serde_json::from_slice(&bytes).map_err(|_| "更新健康消息格式无效".into());
        }
        bytes.push(byte[0]);
    }
    Err("更新健康消息过长".into())
}

pub(super) struct Monitor {
    listener: UnixListener,
    path: PathBuf,
    nonce: String,
    executable: PathBuf,
    hash: String,
    version: String,
    pub data_access_granted: bool,
    pub ready_pid: Option<u32>,
}
impl Monitor {
    pub fn create(executable: PathBuf, hash: String, version: String) -> Result<Self> {
        // Darwin sockaddr_un has a short path limit. Keep the socket out of a
        // possibly long Applications/data path, in a fresh owner-only directory.
        let root = fs::canonicalize("/tmp").map_err(|e| e.to_string())?;
        let mut random = [0; 16];
        getrandom::fill(&mut random).map_err(|_| "无法生成健康通道目录")?;
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let directory = root.join(format!("xwx-health-{name}"));
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|e| e.to_string())?;
        match Self::bind(&directory, executable, hash, version) {
            Ok(value) => Ok(value),
            Err(error) => {
                let _ = fs::remove_dir(&directory);
                Err(error)
            }
        }
    }
    pub fn bind(
        directory: &Path,
        executable: PathBuf,
        hash: String,
        version: String,
    ) -> Result<Self> {
        private_directory(directory)?;
        let path = directory.join("health.sock");
        let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let mut random = [0; 32];
        getrandom::fill(&mut random).map_err(|_| "无法生成本次更新挑战")?;
        let nonce = random.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self {
            listener,
            path,
            nonce,
            executable,
            hash,
            version,
            data_access_granted: false,
            ready_pid: None,
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn authenticate(&self, stream: &UnixStream) -> Result<u32> {
        let pid = peer_pid(stream)?;
        if process_path(pid)? != self.executable || digest(&self.executable)? != self.hash {
            return Err("健康确认不是来自预期更新程序".into());
        }
        Ok(pid)
    }
    fn matches(&self, value: &serde_json::Value, pid: u32, phase: &str) -> bool {
        value["challenge"] == self.nonce
            && value["version"] == self.version
            && value["pid"].as_u64() == Some(pid as u64)
            && value["phase"] == phase
    }
    pub fn wait(&mut self, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        let mut last_error = "尚无连接".to_string();
        while Instant::now() < deadline {
            let (mut stream, _) = match self.listener.accept() {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let attempt = (|| -> Result<()> {
                // Darwin accepts can inherit O_NONBLOCK from the listener.
                // Frames use explicit bounded blocking reads after accept.
                stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                let pid = self.authenticate(&stream)?;
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("启动健康确认超时".into());
                }
                stream
                    .set_read_timeout(Some(remaining.min(Duration::from_secs(3))))
                    .map_err(|e| e.to_string())?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .map_err(|e| e.to_string())?;
                write_frame(
                    &mut stream,
                    &serde_json::json!({"challenge":self.nonce,"version":self.version}),
                )?;
                if !self.matches(
                    &read_frame_until(
                        &mut stream,
                        deadline.min(Instant::now() + Duration::from_secs(3)),
                    )?,
                    pid,
                    "starting",
                ) {
                    return Err("启动确认不匹配当前更新任务".into());
                }
                // Set before sending GO: after this point data may change, even
                // if the client crashes before the helper sees another frame.
                self.data_access_granted = true;
                write_frame(&mut stream, &serde_json::json!({"continue":self.nonce}))?;
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("启动健康确认超时".into());
                }
                stream
                    .set_read_timeout(Some(remaining))
                    .map_err(|e| e.to_string())?;
                if !self.matches(&read_frame_until(&mut stream, deadline)?, pid, "ready")
                    || self.authenticate(&stream)? != pid
                {
                    return Err("新版健康确认无效".into());
                }
                write_frame(&mut stream, &serde_json::json!({"accepted":self.nonce}))?;
                self.ready_pid = Some(pid);
                Ok(())
            })();
            if attempt.is_ok() {
                return Ok(());
            }
            if self.data_access_granted {
                return attempt;
            }
            if let Err(error) = attempt {
                last_error = error;
            }
            // Reject invalid clients without allowing them to acknowledge the
            // task or keeping their connection alive during recovery.
        }
        Err(format!("等待新版启动健康确认超时：{last_error}"))
    }
}
impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        if let Some(parent) = self.path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}

pub(super) struct Client {
    stream: UnixStream,
    challenge: String,
    version: String,
}
impl Client {
    pub fn connect(path: &Path, version: &str, expected_server: &Path) -> Result<Self> {
        private_directory(path.parent().ok_or("健康通道目录无效")?)?;
        let mut stream = UnixStream::connect(path).map_err(|e| e.to_string())?;
        if process_path(peer_pid(&stream)?)? != expected_server {
            return Err("健康通道服务端不是指定更新助手".into());
        }
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let challenge = read_frame(&mut stream)?;
        let nonce = challenge["challenge"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or("健康通道挑战无效")?;
        if challenge["version"] != version {
            return Err("健康通道目标版本不匹配".into());
        }
        let mut client = Self {
            stream,
            challenge: nonce.into(),
            version: version.into(),
        };
        client.send("starting")?;
        if read_frame(&mut client.stream)?["continue"] != client.challenge {
            return Err("助手未允许新版访问数据".into());
        }
        Ok(client)
    }
    fn send(&mut self, phase: &str) -> Result<()> {
        write_frame(
            &mut self.stream,
            &serde_json::json!({"challenge":self.challenge,"version":self.version,"pid":std::process::id(),"phase":phase}),
        )
    }
    pub fn ready(&mut self) -> Result<()> {
        self.send("ready")?;
        if read_frame(&mut self.stream)?["accepted"] != self.challenge {
            return Err("助手未接受新版健康确认".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn final_frame_is_readable_after_peer_closes() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        write_frame(&mut writer, &serde_json::json!({"accepted":"current"})).unwrap();
        drop(writer);
        assert_eq!(read_frame(&mut reader).unwrap()["accepted"], "current");
    }
    #[test]
    fn partial_or_oversized_messages_are_bounded_by_an_absolute_deadline() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(b"{").unwrap();
        let began = Instant::now();
        assert!(read_frame_until(&mut reader, began + Duration::from_millis(40)).is_err());
        assert!(began.elapsed() < Duration::from_secs(1));
        drop(writer);
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        writer.write_all(&vec![b'x'; LIMIT + 1]).unwrap();
        assert!(read_frame(&mut reader).is_err());
    }
    #[test]
    fn kernel_process_check_detects_current_executable() {
        assert!(executable_in_use(&std::env::current_exe().unwrap()).unwrap());
    }
    // These real-kernel fixtures hash the large debug test executable.
    // Serialize that I/O so competing fixtures cannot spend the wire deadline
    // before their first frame; production deadlines and rejection checks stay exact.
    static HEALTH_FIXTURE_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn monitor() -> Monitor {
        let executable = std::env::current_exe().unwrap();
        Monitor::create(
            executable.clone(),
            digest(&executable).unwrap(),
            "1.0.0".into(),
        )
        .unwrap()
    }
    #[test]
    fn real_unix_peer_acknowledges_start_and_ready_without_marker_files() {
        let _fixture = HEALTH_FIXTURE_SERIAL.lock().unwrap();
        let mut server = monitor();
        let path = server.path().to_path_buf();
        let exe = std::env::current_exe().unwrap();
        let child = std::thread::spawn(move || {
            let mut client = Client::connect(&path, "1.0.0", &exe).unwrap();
            client.ready().unwrap();
        });
        server.wait(Duration::from_secs(20)).unwrap();
        child.join().unwrap();
        assert!(server.data_access_granted);
        assert_eq!(server.ready_pid, Some(std::process::id()));
    }
    #[test]
    fn forged_pid_version_challenge_and_ready_phase_never_grant_data_access() {
        let _fixture = HEALTH_FIXTURE_SERIAL.lock().unwrap();
        for field in ["pid", "version", "challenge", "phase"] {
            let mut server = monitor();
            let path = server.path().to_path_buf();
            let child = std::thread::spawn(move || {
                let mut stream = UnixStream::connect(path).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(20)))
                    .unwrap();
                let challenge = read_frame(&mut stream).unwrap();
                let mut receipt = serde_json::json!({"pid":std::process::id(),"version":"1.0.0","challenge":challenge["challenge"],"phase":"starting"});
                receipt[field] = match field {
                    "pid" => serde_json::json!(std::process::id() + 1),
                    "phase" => serde_json::json!("ready"),
                    _ => serde_json::json!("wrong"),
                };
                write_frame(&mut stream, &receipt).unwrap();
                assert!(read_frame(&mut stream).is_err());
            });
            assert!(server.wait(Duration::from_secs(5)).is_err());
            child.join().unwrap();
            assert!(!server.data_access_granted);
            assert!(server.ready_pid.is_none());
        }
    }
    #[test]
    fn stale_file_and_wrong_executable_cannot_acknowledge_current_task() {
        let _fixture = HEALTH_FIXTURE_SERIAL.lock().unwrap();
        let mut server = monitor();
        fs::write(
            server.path.parent().unwrap().join("old-ready.json"),
            br#"{"ready":true,"version":"1.0.0"}"#,
        )
        .unwrap();
        assert!(server.wait(Duration::from_millis(30)).is_err());
        assert!(!server.data_access_granted);
        fs::remove_file(server.path.parent().unwrap().join("old-ready.json")).unwrap();
        let old_nonce = server.nonce.clone();
        drop(server);
        let mut server = monitor();
        assert_ne!(old_nonce, server.nonce);
        server.executable = PathBuf::from("/not-the-expected-executable");
        let path = server.path().to_path_buf();
        let child = std::thread::spawn(move || {
            let mut stream = UnixStream::connect(path).unwrap();
            assert!(read_frame(&mut stream).is_err());
        });
        assert!(server.wait(Duration::from_millis(50)).is_err());
        child.join().unwrap();
        assert!(!server.data_access_granted);
    }
    #[test]
    fn disconnect_after_grant_keeps_data_phase_uncertain_and_never_reports_ready() {
        let _fixture = HEALTH_FIXTURE_SERIAL.lock().unwrap();
        let mut server = monitor();
        let path = server.path().to_path_buf();
        let exe = std::env::current_exe().unwrap();
        let child = std::thread::spawn(move || {
            let _client = Client::connect(&path, "1.0.0", &exe).unwrap();
        });
        assert!(server.wait(Duration::from_secs(20)).is_err());
        child.join().unwrap();
        assert!(server.data_access_granted);
        assert!(server.ready_pid.is_none());
    }
    #[test]
    fn incorrect_helper_identity_and_target_version_fail_before_client_data_phase() {
        let _fixture = HEALTH_FIXTURE_SERIAL.lock().unwrap();
        for wrong_server in [true, false] {
            let mut server = monitor();
            let path = server.path().to_path_buf();
            let expected = if wrong_server {
                PathBuf::from("/not-the-helper")
            } else {
                std::env::current_exe().unwrap()
            };
            let child = std::thread::spawn(move || {
                Client::connect(
                    &path,
                    if wrong_server { "1.0.0" } else { "9.0.0" },
                    &expected,
                )
                .is_err()
            });
            assert!(server.wait(Duration::from_secs(5)).is_err());
            assert!(child.join().unwrap());
            assert!(!server.data_access_granted);
        }
    }
}
