using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
[assembly: AssemblyVersion("2.0.0.0")]
internal static class Launcher {
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
        string script = login ? "login.cjs" : "agent.cjs";
        foreach (string file in new string[] { "node.exe", script, "native.cjs", "AIVID-Protect.exe" })
          if (!File.Exists(Path.Combine(root, file))) throw new Exception("Extract the entire ZIP to one writable folder first. Missing " + file);
        Console.WriteLine("CMMTools AIVID RDP agent 2.0 - " + (login ? "manual login" : "paired agent"));
        var start = new ProcessStartInfo(Path.Combine(root, "node.exe"));
        start.WorkingDirectory = root; start.UseShellExecute = false;
        start.Arguments = check ? "-e \"require('./agent.cjs');console.log('Runtime and adapter OK');\"" : "\"" + Path.Combine(root, script) + "\"";
        using (var process = Process.Start(start)) {
          if (process == null) throw new Exception("The bundled Node runtime could not start.");
          process.WaitForExit(); code = process.ExitCode;
        }
        mutex.ReleaseMutex();
      }
    } catch (Exception error) { Console.Error.WriteLine(error.Message); }
    if (!check) { Console.WriteLine("Press Enter to close this launcher. Your Chrome window is kept open."); Console.ReadLine(); }
    return code;
  }
}
