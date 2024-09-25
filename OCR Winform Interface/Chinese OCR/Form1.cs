namespace Chinese_OCR
{
    public partial class Form1 : Form
    {
        public Form1()
        {
            InitializeComponent();
        }

        private void button1_Click(object sender, EventArgs e)
        {
            this.Hide();
            Thread.Sleep(200);
            ScreenShotForm newForm = new ScreenShotForm();
            newForm.ShowDialog();
            this.Show();
        }

        private void button2_Click(object sender, EventArgs e)
        {
            this.Hide();
            Thread.Sleep(200);
            RegionSelector newForm = new RegionSelector();
            newForm.ShowDialog();
            this.Show();
        }
    }
}