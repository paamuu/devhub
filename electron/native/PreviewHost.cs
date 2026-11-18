using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading.Tasks;

// A separate Job Object owns each preview tree. Closing the parent pipe or this
// process releases the job handle, including descendants whose launcher exited.
internal static class PreviewHost {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public short ShowWindow, ReservedSize;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, int length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo info, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr source, IntPtr original, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr attributes, uint disposition, uint flags, IntPtr template);

    static IntPtr Inherit(IntPtr original) {
        IntPtr copy;
        if (!DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), out copy, 0, true, 2)) throw new IOException("handle");
        return copy;
    }
    static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
            else { result.Append('\\', slashes); result.Append(character); }
            slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }
    static int Main(string[] args) {
        if (args.Length == 2 && args[0] == "--protect-directory") {
            try {
                var sid = WindowsIdentity.GetCurrent().User;
                var security = new DirectorySecurity();
                security.SetAccessRuleProtection(true, false);
                security.SetOwner(sid);
                security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
                Directory.SetAccessControl(args[1], security);
                return 0;
            } catch { return 73; }
        }
        if (args.Length != 2) return 64;
        IntPtr job = IntPtr.Zero, input = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, nullFile = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        bool assigned = false;
        try {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new IOException("job");
            var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(limits))) throw new IOException("limits");
            nullFile = CreateFile("NUL", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            input = Inherit(nullFile); output = Inherit(GetStdHandle(-11)); error = Inherit(GetStdHandle(-12));
            var startup = new StartupInfo(); startup.Size = Marshal.SizeOf(startup); startup.Flags = 0x100;
            startup.Input = input; startup.Output = output; startup.Error = error;
            var command = new StringBuilder(Quote(args[0]) + " " + Quote(args[1]));
            if (!CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out child)) throw new IOException("spawn");
            if (!AssignProcessToJobObject(job, child.Process)) throw new IOException("assign");
            assigned = true;
            if (ResumeThread(child.Thread) == 0xffffffff) throw new IOException("resume");
            var control = Task.Factory.StartNew(() => Console.ReadLine());
            while (WaitForSingleObject(child.Process, 50) == 258) {
                if (control.IsCompleted) return 0;
            }
            uint code;
            return GetExitCodeProcess(child.Process, out code) ? unchecked((int)code) : 70;
        } catch { Console.Error.WriteLine("DevHub process host could not launch the preview."); return 70; }
        finally {
            if (child.Process != IntPtr.Zero && !assigned) TerminateProcess(child.Process, 70);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (child.Process != IntPtr.Zero) { WaitForSingleObject(child.Process, 5000); CloseHandle(child.Process); }
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (nullFile != IntPtr.Zero && nullFile != new IntPtr(-1)) CloseHandle(nullFile);
        }
    }
}
