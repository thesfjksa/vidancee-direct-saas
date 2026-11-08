using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
[assembly: AssemblyVersion("3.1.0.0")]
internal static class Launcher {
  [STAThread]
  public static int Main(string[] args) {
    bool check = args.Length == 1 && args[0] == "--check";
    string root = AppDomain.CurrentDomain.BaseDirectory;
    bool login = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location).IndexOf("Login", StringComparison.OrdinalIgnoreCase) >= 0;
    int code = 1;
    try {
      if (args.Length > 0 && !check) throw new Exception("Double-click this launcher, or use --check.");
      string tag;
      using (var sha = SHA256.Create()) tag = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant()))).Replace("-", "");
      bool acquired;
      using (var mutex = new Mutex(true, "Local\\CMMToolsAivid_" + tag, out acquired)) {
        if (!acquired) throw new Exception("An AIVID agent or launcher is already running. Close it before starting another.");
        string script = login ? "login.cjs" : "worker.cjs";
        foreach (string file in new string[] { "node.exe", script, "native.cjs", "AIVID-Protect.exe" })
          if (!File.Exists(Path.Combine(root, file))) throw new Exception("Extract the entire ZIP to one writable folder first. Missing " + file);
        Console.WriteLine("CMMTools AIVID RDP agent 3.1.0 - " + (login ? "manual login" : "paired agent"));
        string site = null, pairingCode = null;
        if (check) { PairingForm.SelfTest(); site = "https://cmmtools.site"; pairingCode = "AABBCCDDEEFF001122334455"; }
        else if (!login && !File.Exists(Path.Combine(root, ".aivid-agent.json"))) {
          Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
          using (var pairing = new PairingForm()) {
            if (pairing.ShowDialog() != DialogResult.OK) return 0;
            site = pairing.BaseUrl; pairingCode = pairing.Code;
          }
        }
        for (int attempt=0; attempt<2; attempt++) {
        var start = new ProcessStartInfo(Path.Combine(root, "node.exe"));
        start.WorkingDirectory = root; start.UseShellExecute = false;
        if (pairingCode != null) { start.RedirectStandardInput = true; start.EnvironmentVariables["AIVID_PAIRING_STDIN"] = "1"; }
        start.Arguments = check ? "-e \"require('./agent.cjs').readPairingInput().then(p=>{if(p.origin!=='https://cmmtools.site'||p.code!=='AABBCCDDEEFF001122334455')process.exit(1);console.log('Runtime, adapter and pairing pipe OK')}).catch(()=>process.exit(1));\"" : "\"" + Path.Combine(root, script) + "\"";
        using (var process = Process.Start(start)) {
          if (process == null) throw new Exception("The bundled Node runtime could not start.");
          if (pairingCode != null) {
            // One-use code stays out of command lines, environment and files.
            byte[] input = new UTF8Encoding(false).GetBytes(site + "\n" + pairingCode + "\n");
            process.StandardInput.BaseStream.Write(input, 0, input.Length); process.StandardInput.BaseStream.Flush();
            process.StandardInput.Close(); pairingCode = null;
          }
          process.WaitForExit(); code = process.ExitCode;
        }
          if (check || login || code != 23 || attempt == 1) break;
          Console.WriteLine("Reconnect this worker with a fresh Admin pairing code.");
          Application.EnableVisualStyles();
          using (var pairing = new PairingForm()) {
            if (pairing.ShowDialog() != DialogResult.OK) return 0;
            site = pairing.BaseUrl; pairingCode = pairing.Code;
          }
        }
        mutex.ReleaseMutex();
      }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); }
    if (!check) { Console.WriteLine("Press Enter to close this launcher. Your AIVID browser window is kept open."); Console.ReadLine(); }
    return code;
  }
}
