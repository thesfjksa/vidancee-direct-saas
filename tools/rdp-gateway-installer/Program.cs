using System.Diagnostics;
using System.Net;
using System.Net.Mail;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace CMMTools.RdpGatewaySetup;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new SetupWindow());
    }
}

internal sealed class SetupWindow : Form
{
    private readonly TextBox server, sshUser, sshPassword, sshKey, sshPort, domain, email, windowsIp, authKey;
    private readonly TextBox output, adminPassword;
    private readonly Button deployButton, copyButton;
    private string? trustedHostFingerprint;

    public SetupWindow()
    {
        Text = "CMMTools | Windows RDP Gateway Setup";
        Width = 875;
        Height = 890;
        MinimumSize = new Size(700, 700);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10);
        BackColor = Color.FromArgb(245, 248, 254);
        ForeColor = Color.FromArgb(24, 36, 56);

        var root = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, Padding = new Padding(18),
            ColumnCount = 1, RowCount = 6, AutoScroll = true
        };
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 340));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 145));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        Controls.Add(root);

        var heading = new Label
        {
            Text = "CMMTools  •  RDP Gateway Installer\nGUI setup for your Windows RDP + a new Ubuntu 24.04 VPS",
            Dock = DockStyle.Fill, Font = new Font("Segoe UI", 15, FontStyle.Bold),
            Padding = new Padding(3, 4, 0, 0)
        };
        root.Controls.Add(heading, 0, 0);

        var links = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = false };
        Link(links, "Get a Linux VPS", "https://hpanel.hostinger.com/");
        Link(links, "Install Tailscale on Windows", "https://tailscale.com/download/windows");
        Link(links, "Create Tailscale auth key", "https://login.tailscale.com/admin/settings/keys");
        Link(links, "Open Hostinger DNS", "https://hpanel.hostinger.com/");
        root.Controls.Add(links, 0, 1);

        var grid = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 9 };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 245));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        for (var i = 0; i < 9; i++) grid.RowStyles.Add(new RowStyle(SizeType.Absolute, 36));
        root.Controls.Add(grid, 0, 2);

        server      = Field(grid, 0, "Ubuntu VPS public IP", "");
        sshUser     = Field(grid, 1, "VPS SSH username", "root");
        sshPort     = Field(grid, 2, "SSH port", "22");
        sshPassword = Field(grid, 3, "SSH password / key passphrase", "", secret: true);
        sshKey      = Field(grid, 4, "SSH private key file (optional)", "");
        domain      = Field(grid, 5, "Gateway HTTPS domain", "rdp.cmmtools.site");
        email       = Field(grid, 6, "TLS certificate email", "");
        windowsIp   = Field(grid, 7, "Windows Tailscale IP (100.x.x.x)", "");
        authKey     = Field(grid, 8, "One-time Tailscale auth key", "", secret: true);

        var actionRow = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 7, 0, 0) };
        var detect = new Button { Text = "Detect Windows Tailscale IP", AutoSize = true, Height = 36 };
        detect.Click += (_, _) => DetectWindowsIp();
        actionRow.Controls.Add(detect);
        var browse = new Button { Text = "Browse SSH key…", AutoSize = true, Height = 36 };
        browse.Click += (_, _) =>
        {
            using var picker = new OpenFileDialog { Title = "Select the private SSH key for your VPS",
                Filter = "SSH keys (*.pem;*.key;id_*)|*.pem;*.key;id_*|All files (*.*)|*.*" };
            if (picker.ShowDialog(this) == DialogResult.OK) sshKey.Text = picker.FileName;
        };
        actionRow.Controls.Add(browse);
        deployButton = new Button
        {
            Text = "Install gateway on my VPS", AutoSize = true, Height = 38,
            BackColor = Color.FromArgb(37, 105, 230), ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        deployButton.Click += async (_, _) => await DeployAsync();
        actionRow.Controls.Add(deployButton);
        root.Controls.Add(actionRow, 0, 3);

        var notes = new GroupBox
        {
            Dock = DockStyle.Fill, Text = "Important — what the installer does and does NOT do",
            Padding = new Padding(12), Font = new Font("Segoe UI", 9)
        };
        notes.Controls.Add(new Label
        {
            Dock = DockStyle.Fill, AutoSize = false,
            Text = "• You need a NEW Ubuntu 24.04 Linux VPS. The EXE runs on your existing Windows RDP.\n" +
                   "• DNS must already point the gateway domain to the VPS public IP; open ports 80/443 on the VPS firewall.\n" +
                   "• Install/sign in to Tailscale on Windows; use a ONE-TIME auth key to join the Linux VPS.\n" +
                   "• Your Edge agent is not changed. After installation, CREATE a separate Guacamole user, Windows account and drive.\n" +
                   "• Do NOT enable the CMMTools viewer until customer isolation and direct AIVID billing are verified.",
            Padding = new Padding(2, 8, 2, 0)
        });
        root.Controls.Add(notes, 0, 4);

        var statusArea = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 2, ColumnCount = 1 };
        statusArea.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        statusArea.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var passwordRow = new FlowLayoutPanel { Dock = DockStyle.Fill };
        passwordRow.Controls.Add(new Label
        {
            Text = "New Guacamole admin password:", AutoSize = true, Padding = new Padding(0, 9, 0, 0)
        });
        adminPassword = new TextBox
        {
            ReadOnly = true, Width = 355, PlaceholderText = "Shown here after successful installation",
            Margin = new Padding(5, 7, 4, 0)
        };
        passwordRow.Controls.Add(adminPassword);
        copyButton = new Button { Text = "Copy", Enabled = false, AutoSize = true };
        copyButton.Click += (_, _) =>
        {
            if (adminPassword.Text.Length > 0) Clipboard.SetText(adminPassword.Text);
        };
        passwordRow.Controls.Add(copyButton);
        statusArea.Controls.Add(passwordRow, 0, 0);
        output = new TextBox
        {
            Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill,
            Font = new Font("Consolas", 9), BackColor = Color.FromArgb(17, 30, 49),
            ForeColor = Color.FromArgb(225, 239, 255),
            Text = "Ready. Enter your VPS details, Windows Tailscale IP and a one-time Tailscale key.\r\n" +
                   "No terminal or CLI window is required. Do not paste passwords in chat."
        };
        statusArea.Controls.Add(output, 0, 1);
        root.Controls.Add(statusArea, 0, 5);
    }

    private static void Link(FlowLayoutPanel panel, string label, string url)
    {
        var button = new Button { Text = label, AutoSize = true, Height = 31, Margin = new Padding(2, 0, 8, 0) };
        button.Click += (_, _) => Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        panel.Controls.Add(button);
    }

    private static TextBox Field(TableLayoutPanel grid, int row, string label, string value, bool secret = false)
    {
        grid.Controls.Add(new Label
        {
            Text = label, AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleLeft
        }, 0, row);
        var box = new TextBox
        {
            Dock = DockStyle.Fill, Text = value, UseSystemPasswordChar = secret,
            Margin = new Padding(5, 4, 5, 4)
        };
        grid.Controls.Add(box, 1, row);
        return box;
    }

    private void Log(string value)
    {
        if (InvokeRequired) { BeginInvoke(() => Log(value)); return; }
        output.AppendText("\r\n" + DateTime.Now.ToString("HH:mm:ss") + "  " + value.Replace("\n", "\r\n"));
    }

    private void DetectWindowsIp()
    {
        try
        {
            var tailscale = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Tailscale", "tailscale.exe");
            if (!File.Exists(tailscale))
                throw new InvalidOperationException("Tailscale is not installed. Click 'Install Tailscale on Windows', sign in, then retry.");
            var info = new ProcessStartInfo(tailscale, "ip -4")
            {
                CreateNoWindow = true, UseShellExecute = false,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            using var p = Process.Start(info) ?? throw new InvalidOperationException("Tailscale could not start.");
            if (!p.WaitForExit(10000)) { p.Kill(); throw new InvalidOperationException("Tailscale did not respond."); }
            var ip = p.StandardOutput.ReadToEnd().Trim();
            if (!IsTailscaleIp(ip)) throw new InvalidOperationException("Tailscale is not signed in or no private IP is assigned.");
            windowsIp.Text = ip;
            Log("Windows Tailscale IP detected: " + ip);
        }
        catch (Exception ex) { MessageBox.Show(this, ex.Message, "Tailscale", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }

    private static bool IsTailscaleIp(string value)
    {
        if (!IPAddress.TryParse(value, out var ip) || ip.AddressFamily != AddressFamily.InterNetwork) return false;
        var b = ip.GetAddressBytes();
        return b[0] == 100 && b[1] >= 64 && b[1] <= 127;
    }

    private sealed record Details(string Server, string User, int Port, string Password, string Key,
        string Domain, string Email, string WindowsIp, string TailscaleKey);

    private Details Gather()
    {
        var ip = server.Text.Trim();
        if (!IPAddress.TryParse(ip, out var address) || address.AddressFamily != AddressFamily.InterNetwork)
            throw new InvalidOperationException("Enter the new Linux VPS public IPv4 address.");
        if (!int.TryParse(sshPort.Text, out var port) || port < 1 || port > 65535)
            throw new InvalidOperationException("Enter a valid VPS SSH port.");
        var user = sshUser.Text.Trim();
        if (!Regex.IsMatch(user, @"^[a-z_][a-z0-9_-]{0,31}$", RegexOptions.IgnoreCase))
            throw new InvalidOperationException("Enter your actual VPS SSH username (root recommended).");
        var key = sshKey.Text.Trim();
        if (key.Length > 0 && !File.Exists(key)) throw new InvalidOperationException("SSH key file does not exist.");
        if (key.Length == 0 && sshPassword.Text.Length == 0)
            throw new InvalidOperationException("Enter the VPS SSH password or choose a private key file.");
        var host = domain.Text.Trim().ToLowerInvariant();
        if (host.Length > 253 || !Regex.IsMatch(host, @"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"))
            throw new InvalidOperationException("Enter a valid HTTPS hostname, such as rdp.cmmtools.site.");
        var mail = email.Text.Trim();
        if (!Regex.IsMatch(mail, @"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$") ||
            !MailAddress.TryCreate(mail, out _))
            throw new InvalidOperationException("Enter your email for the free TLS certificate.");
        if (!IsTailscaleIp(windowsIp.Text.Trim()))
            throw new InvalidOperationException("The Windows Tailscale IP must be within 100.64.0.0/10.");
        var tskey = authKey.Text.Trim();
        if (!Regex.IsMatch(tskey, @"^tskey-auth-[A-Za-z0-9-]{20,240}$"))
            throw new InvalidOperationException("Create and enter a ONE-TIME Tailscale auth key from Tailscale Admin.");
        return new(ip, user, port, sshPassword.Text, key, host, mail, windowsIp.Text.Trim(), tskey);
    }

    private async Task DeployAsync()
    {
        Details d;
        try { d = Gather(); }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Check the setup form", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (MessageBox.Show(this,
            "This will install Docker, Tailscale, Nginx, Certbot and Apache Guacamole on a NEW Ubuntu 24.04 VPS.\n\n" +
            "It does not touch your existing Windows Edge agent or Hostinger web application.\n" +
            "The installer will refuse to overwrite an existing CMMTools Guacamole installation.\n\nContinue?",
            "Confirm VPS gateway installation", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        deployButton.Enabled = false;
        adminPassword.Clear();
        copyButton.Enabled = false;
        trustedHostFingerprint = null;
        try
        {
            Log("Checking that the gateway DNS points to your VPS.");
            var resolved = await Dns.GetHostAddressesAsync(d.Domain);
            if (!resolved.Any(ip => ip.AddressFamily == AddressFamily.InterNetwork && ip.ToString() == d.Server))
                throw new InvalidOperationException("DNS is not ready: create an A record for " + d.Domain +
                    " pointing to " + d.Server + " in Hostinger DNS, then retry.");

            Log("Connecting to the Linux VPS via authenticated SSH.");
            var result = await Task.Run(() => Deploy(d));
            Log(result.Stdout);
            if (result.ExitStatus != 0)
                throw new InvalidOperationException("The VPS returned an installation error (exit " + result.ExitStatus +
                    "). Review the status output. No CMMTools feature flags were enabled.");
            if (!result.Stdout.Contains("GATEWAY=INSTALLED", StringComparison.Ordinal))
                throw new InvalidOperationException("The VPS did not confirm successful gateway installation.");
            adminPassword.Text = result.AdminPassword;
            copyButton.Enabled = true;
            Log("GATEWAY INSTALLED at https://" + d.Domain + "/guacamole/");
            Log("Admin login: guacadmin — COPY AND SAVE THE GENERATED PASSWORD ABOVE.");
            Log("NEXT: In Guacamole, create the customer's restricted login, private Windows RDP connection and transfer drive.");
            Log("NEXT: After verifying isolation and billing, enable AIVID_RDP_VIEW_* in Hostinger web app.");
            MessageBox.Show(this,
                "The gateway is installed.\n\n" +
                "1. Copy and save the generated admin password before closing this window.\n" +
                "2. Configure a separate customer account and Windows RDP connection inside Guacamole.\n" +
                "3. Configure CMMTools environment variables after testing.\n\n" +
                "No customer desktop access was automatically enabled.",
                "Gateway installed", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex)
        {
            Log("INSTALLATION NOT CONFIRMED: " + ex.Message);
            MessageBox.Show(this, ex.Message, "Setup needs attention",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally { deployButton.Enabled = true; }
    }

    private ConnectionInfo Connection(Details d)
    {
        AuthenticationMethod method;
        if (d.Key.Length != 0)
        {
            var file = d.Password.Length == 0
                ? new PrivateKeyFile(d.Key)
                : new PrivateKeyFile(d.Key, d.Password);
            method = new PrivateKeyAuthenticationMethod(d.User, file);
        }
        else method = new PasswordAuthenticationMethod(d.User, d.Password);
        return new ConnectionInfo(d.Server, d.Port, d.User, method) { Timeout = TimeSpan.FromSeconds(20) };
    }

    private void CheckHostKey(object? sender, HostKeyEventArgs e)
    {
        var fingerprint = "SHA256:" + Convert.ToBase64String(SHA256.HashData(e.HostKey)).TrimEnd('=');
        if (trustedHostFingerprint != null)
        {
            e.CanTrust = string.Equals(fingerprint, trustedHostFingerprint, StringComparison.Ordinal);
            return;
        }
        var approved = false;
        Invoke(() =>
        {
            approved = MessageBox.Show(this,
                "Verify this SSH server host-key fingerprint using your VPS provider's console before trusting it:\n\n" +
                fingerprint +
                "\n\nIf it does not match the VPS you own, choose NO.\n\n" +
                "Trust this VPS for the current installation?",
                "Verify Linux VPS identity", MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning) == DialogResult.Yes;
        });
        if (approved) trustedHostFingerprint = fingerprint;
        e.CanTrust = approved;
    }

    private sealed record Deployment(string Stdout, int ExitStatus, string AdminPassword);

    private Deployment Deploy(Details d)
    {
        var adminPass = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
        var dbPass = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var salt = RandomNumberGenerator.GetBytes(32);
        var passwordBytes = Encoding.UTF8.GetBytes(adminPass);
        var salted = new byte[passwordBytes.Length + salt.Length];
        Buffer.BlockCopy(passwordBytes, 0, salted, 0, passwordBytes.Length);
        Buffer.BlockCopy(salt, 0, salted, passwordBytes.Length, salt.Length);
        var hash = SHA256.HashData(salted);
        var adminSql =
            "UPDATE guacamole_user SET " +
            "password_salt=decode('" + Convert.ToHexString(salt) + "','hex'), " +
            "password_hash=decode('" + Convert.ToHexString(hash) + "','hex'), " +
            "password_date=CURRENT_TIMESTAMP WHERE entity_id=(SELECT entity_id FROM guacamole_entity " +
            "WHERE name='guacadmin' AND type='USER');\n";
        var conf = "DOMAIN=" + d.Domain + "\nEMAIL=" + d.Email + "\nWINDOWS_IP=" + d.WindowsIp +
            "\nTAILSCALE_KEY=" + d.TailscaleKey + "\nDB_PASSWORD=" + dbPass + "\n";
        string? stage = null;
        using var ssh = new SshClient(Connection(d));
        ssh.HostKeyReceived += CheckHostKey;
        ssh.Connect();
        try
        {
            var before = ssh.RunCommand("umask 077; mktemp -d /tmp/cmmtools-gateway.XXXXXXXX");
            stage = before.Result.Trim();
            if (before.ExitStatus != 0 || !Regex.IsMatch(stage, @"^/tmp/cmmtools-gateway\.[a-zA-Z0-9]{8}$"))
                throw new InvalidOperationException("Cannot create a private staging directory on the VPS.");
            using (var sftp = new SftpClient(Connection(d)))
            {
                sftp.HostKeyReceived += CheckHostKey;
                sftp.Connect();
                Upload(sftp, stage + "/deploy.sh", Resource("CMMTools.Gateway.Deploy"));
                Upload(sftp, stage + "/docker-compose.yml", Resource("CMMTools.Gateway.Compose"));
                Upload(sftp, stage + "/setup.conf", Encoding.UTF8.GetBytes(conf));
                Upload(sftp, stage + "/admin.sql", Encoding.UTF8.GetBytes(adminSql));
                sftp.Disconnect();
            }
            var command = ssh.CreateCommand(
                "sudo -n bash " + stage + "/deploy.sh");
            command.CommandTimeout = TimeSpan.FromMinutes(25);
            var result = command.Execute();
            return new Deployment(result + "\n" + command.Error, command.ExitStatus ?? -1, adminPass);
        }
        finally
        {
            // Do not leave Tailscale authentication tokens or SQL files on VPS.
            if (stage != null && Regex.IsMatch(stage, @"^/tmp/cmmtools-gateway\.[a-zA-Z0-9]{8}$"))
            {
                try { ssh.RunCommand("rm -rf -- " + stage); } catch { /* VPS may have disconnected */ }
            }
            ssh.Disconnect();
        }
    }

    private static void Upload(SftpClient client, string remotePath, byte[] bytes)
    {
        using var buffer = new MemoryStream(bytes);
        client.UploadFile(buffer, remotePath, false);
    }

    private static byte[] Resource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new InvalidOperationException("Installer package is missing embedded resource: " + name);
        using var output = new MemoryStream();
        stream.CopyTo(output);
        return output.ToArray();
    }
}
