using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

[assembly: AssemblyTitle("AIVID RDP Runner Launcher")]
[assembly: AssemblyVersion("1.0.0.0")]
internal static class Launcher
{
    private static string Root = AppDomain.CurrentDomain.BaseDirectory;
    private static string Quote(string value) { return "\"" + value + "\""; }
    private static void Require(string relative)
    {
        if (!File.Exists(Path.Combine(Root, relative)))
            throw new FileNotFoundException("Missing " + relative + ". Extract the entire ZIP into one folder first.");
    }
    private static int RunNode(string arguments)
    {
        var info = new ProcessStartInfo(Path.Combine(Root, "node.exe"), arguments);
        info.WorkingDirectory = Root;
        info.UseShellExecute = false;
        info.CreateNoWindow = false;
        using (var process = Process.Start(info))
        {
            if (process == null) throw new InvalidOperationException("Could not start the bundled Node.js runtime.");
            process.WaitForExit();
            return process.ExitCode;
        }
    }
    public static int Main(string[] args)
    {
        bool check = args.Length == 1 && args[0] == "--check";
        int code = 1;
        try
        {
            if (args.Length > 0 && !check) throw new ArgumentException("Usage: double-click this EXE, or run it with --check.");
            bool submit = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location)
                .IndexOf("Submit", StringComparison.OrdinalIgnoreCase) >= 0;
            Console.WriteLine("AIVID " + (submit ? "Submit" : "Preflight") + " - Windows runner");
            Require("node.exe");
            Require("runner.mjs");
            Require("preflight.mjs");
            Require(Path.Combine("node_modules", "playwright", "package.json"));
            if (check)
            {
                code = RunNode("-e \"require('playwright');console.log('Runtime and Playwright OK');\"");
                return code;
            }
            string job = Path.Combine(Root, "trial.job.json");
            if (!File.Exists(job))
            {
                if (submit) throw new InvalidOperationException("Run AIVID-Preflight.exe first, then review trial.job.json before submitting.");
                Require("trial.example.json");
                File.Copy(Path.Combine(Root, "trial.example.json"), job, false);
            }
            Console.WriteLine(submit
                ? "One-job submission. The runner will display the price and require you to type SUBMIT."
                : "Form check only. This mode does not click Generate.");
            code = RunNode(Quote(Path.Combine(Root, "runner.mjs")) + " " + Quote(job) + (submit ? " --submit" : ""));
            if (code != 0) Console.Error.WriteLine("Runner stopped with exit code " + code + ". Read the message above before trying again.");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            code = 1;
        }
        if (!check)
        {
            Console.WriteLine("Press Enter to close this window.");
            Console.ReadLine();
        }
        return code;
    }
}
