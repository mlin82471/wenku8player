using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;

namespace Wenku8Desktop
{
    static class Program
    {
        private static Process serverProcess = null;
        private static Process appProcess = null;
        private static NotifyIcon trayIcon = null;
        private static string appDir = "";
        private static string profileDir = "";
        private static string browserPath = "";

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            appDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\', '/');
            Directory.SetCurrentDirectory(appDir);
            profileDir = Path.Combine(appDir, "profile");

            // 1. Ensure server.js is running
            EnsureServerRunning();

            // 2. Locate browser for --app mode
            browserPath = FindBrowser();

            // 3. Initialize Tray Icon
            SetupTrayIcon();

            // 4. Launch the application window
            LaunchAppWindow();

            // 5. Run message loop
            Application.Run();
        }

        private static void EnsureServerRunning()
        {
            if (CheckServerHealthy("http://127.0.0.1:3000/"))
            {
                return; // Server is already running
            }

            string nodePath = FindNodeExe();
            if (string.IsNullOrEmpty(nodePath))
            {
                MessageBox.Show(
                    "未检测到 Node.js 运行环境！\n\n请安装 Node.js (https://nodejs.org/) 或将 node.exe 放置于本程序所在目录下。",
                    "Wenku8 音乐档案 - 环境提示",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "server.js",
                WorkingDirectory = appDir,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                serverProcess = Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "启动本地音频服务失败：\n" + ex.Message,
                    "错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return;
            }

            // Poll for server readiness (up to 12s)
            for (int i = 0; i < 24; i++)
            {
                Thread.Sleep(500);
                if (CheckServerHealthy("http://127.0.0.1:3000/"))
                {
                    break;
                }
            }
        }

        private static void LaunchAppWindow()
        {
            if (appProcess != null && !appProcess.HasExited)
            {
                // Bring to front if possible
                return;
            }

            if (!string.IsNullOrEmpty(browserPath))
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = browserPath,
                    Arguments = string.Format(
                        "--app=\"http://127.0.0.1:3000\" --window-size=1260,880 --user-data-dir=\"{0}\"",
                        profileDir
                    ),
                    UseShellExecute = false
                };

                try
                {
                    appProcess = Process.Start(psi);
                    // Monitor process exit in background thread
                    ThreadPool.QueueUserWorkItem(delegate
                    {
                        try
                        {
                            if (appProcess != null)
                            {
                                appProcess.WaitForExit();
                                // Window closed -> exit app & clean up server
                                Application.Exit();
                            }
                        }
                        catch { }
                    });
                    return;
                }
                catch { }
            }

            // Fallback: open in default browser
            Process.Start("http://127.0.0.1:3000");
        }

        private static void SetupTrayIcon()
        {
            trayIcon = new NotifyIcon();
            trayIcon.Text = "Wenku8 Audio Archive 播放器";

            string icoPath = Path.Combine(appDir, "app.ico");
            if (File.Exists(icoPath))
            {
                try { trayIcon.Icon = new Icon(icoPath); }
                catch { trayIcon.Icon = SystemIcons.Application; }
            }
            else
            {
                trayIcon.Icon = SystemIcons.Application;
            }

            ContextMenu menu = new ContextMenu();
            MenuItem openItem = new MenuItem("📼 打开播放器窗口", delegate { LaunchAppWindow(); });
            MenuItem webItem = new MenuItem("🌐 在默认浏览器中打开", delegate { Process.Start("http://127.0.0.1:3000"); });
            MenuItem sep = new MenuItem("-");
            MenuItem exitItem = new MenuItem("🚪 退出软件", delegate { ExitApplication(); });

            menu.MenuItems.Add(openItem);
            menu.MenuItems.Add(webItem);
            menu.MenuItems.Add(sep);
            menu.MenuItems.Add(exitItem);

            trayIcon.ContextMenu = menu;
            trayIcon.Visible = true;
            trayIcon.DoubleClick += delegate { LaunchAppWindow(); };

            Application.ApplicationExit += delegate { Cleanup(); };
        }

        private static void ExitApplication()
        {
            Cleanup();
            Environment.Exit(0);
        }

        private static void Cleanup()
        {
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Dispose();
                trayIcon = null;
            }

            if (serverProcess != null && !serverProcess.HasExited)
            {
                try
                {
                    serverProcess.Kill();
                    serverProcess.Dispose();
                }
                catch { }
                serverProcess = null;
            }
        }

        private static string FindBrowser()
        {
            string[] paths = new string[]
            {
                @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                @"C:\Program Files\Google\Chrome\Application\chrome.exe",
                @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string p in paths)
            {
                if (File.Exists(p)) return p;
            }
            return null;
        }

        private static string FindNodeExe()
        {
            string localNode = Path.Combine(appDir, "node.exe");
            if (File.Exists(localNode)) return localNode;

            string pathEnv = Environment.GetEnvironmentVariable("PATH");
            if (!string.IsNullOrEmpty(pathEnv))
            {
                string[] parts = pathEnv.Split(';');
                foreach (string part in parts)
                {
                    string candidate = Path.Combine(part.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
            }
            return null;
        }

        private static bool CheckServerHealthy(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1200;
                req.Method = "GET";
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return res.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }
    }
}
