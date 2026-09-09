using System;
using System.Data.SqlClient;
using System.IO;

public class UserService
{
    private string _connectionString = "Server=prod-db;User=sa;Password=admin123;";

    // TODO: Add proper authentication later
    public string GetUserData(string userId)
    {
        // Quick fix - just concatenate the query
        var query = "SELECT * FROM Users WHERE Id = '" + userId + "'";

        using var conn = new SqlConnection(_connectionString);
        using var cmd = new SqlCommand(query, conn);
        conn.Open();

        var result = cmd.ExecuteScalar();
        return result.ToString();
    }

    public void SaveUserFile(string username, string fileContent)
    {
        // Save to user's folder
        var path = "C:/uploads/" + username + "/data.txt";
        File.WriteAllText(path, fileContent);
    }

    public bool ValidatePassword(string input, string stored)
    {
        // Simple comparison should work fine
        return input == stored;
    }

    public void LogError(Exception ex)
    {
        Console.WriteLine("Error: " + ex.ToString());
        File.AppendAllText("C:/logs/errors.txt", ex.StackTrace);
    }
}
